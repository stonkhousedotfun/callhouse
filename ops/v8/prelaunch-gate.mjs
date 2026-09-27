/**
 * ops/v8/prelaunch-gate.mjs — the pre-launch services gate, in one command.
 *
 *   node ops/v8/prelaunch-gate.mjs --evidence ops/v8/prelaunch-evidence.json \
 *        --relay-url http://relay.railway.internal:8080 \
 *        --pricing-url http://pricing.railway.internal:8790 \
 *        --indexer-url https://<indexer host> --long-id <NVDA long id> \
 *        --notifier-url https://dev-notify.stonkhouse.fun \
 *        --rpc "$RH_RPC" --chain-id 4663
 *
 * INSIDE RAILWAY. The service addresses above resolve only inside the production project, so on launch day
 * `stonkctl prelaunch-gate` runs this file inside the `monitor` service (the keeper image carries it, keeper/Dockerfile):
 *
 *   node /app/ops/v8/prelaunch-gate.mjs --rpc-env RH_RPC --health "relay=http://…/health,…" \
 *        --evidence-b64 <base64 of the evidence JSON> --relay-url … --pricing-url … --indexer-url … --long-id … \
 *        --notifier-url …
 *
 * --rpc-env names the variable that holds the RPC (the monitor service's RH_RPC), so a keyed URL is never on a command
 * line; the monitor child gets it in its environment, never in its argv. --health is the MONITOR_HEALTH list the monitor
 * child's `health` check probes. --evidence-b64 carries the evidence file's JSON to a container that has no copy of it.
 *
 * WHAT IT IS. The services go-live checklist lists four observable
 * checks across 383 lines of packet. This prints one line per check, PASS or FAIL, and on FAIL the
 * exact next action. It exits non-zero unless all four PASS.
 *
 * WHAT IT IS NOT. It never performs the launch action itself. It sends no user alert, opens no subscription,
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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { monitorHouseVaults, monitorThresholds } from "../v2/go-live-gating.mjs";

const execFileAsync = promisify(execFileCb);
/** Resolves to stdout; on a non-zero exit the rejection still carries `.stdout`, which the caller uses. */
const defaultExecFile = async (cmd, args, { env } = {}) => (await execFileAsync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env })).stdout;

export const EXPECTED_CHAIN_ID = 4663;

/**
 * The two monitor alert names the go-live checklist permits while KeeperRewards and MakerVault
 * hold 0. "Clean" today is NOT exit 0: it is exit 1 carrying EXACTLY these two names and no third.
 * A third name is a real finding, so the allowlist is exact rather than a prefix or a count -- a
 * count would let one expected name be swapped for one unexpected one and still read clean.
 */
export const MONITOR_KNOWN_STANDING = ["v2_mon_rewards_budget_low", "v2_mon_vault_inventory_low"];

/**
 * Monitor checks that read NOTHING unless the caller hands them their subject, and that report themselves
 * `skipped` when it does not: the pricing service (priceability, pricer activity) and the House vaults (the epoch
 * boundary stall, the unpinned boundary). The monitor counts a skipped check as completed, so at first
 * this gate passed its `--pricing-url` to /health only, never to the monitor, and read "every check [ok]" over two
 * checks that never ran. The gate now hands both in (below) and a skip of either is a FAIL, not a clean pass.
 *
 * And `health`, the /health probe of every running service. It reads only the targets it is handed
 * (--health, or MONITOR_HEALTH in this gate's own environment, which the monitor child inherits); with none it is
 * `skipped`, and this gate read that as "every check [ok]" although no service was asked anything.
 */
export const MONITOR_LAUNCH_CHECKS = ["house", "pricing", "health"];

/** Why each launch check skips, and what the operator hands in so it runs. */
const SKIP_REASON = {
  house: "no House vault was handed to it (the registry names none)",
  pricing: "no pricing URL was handed to it",
  health: "no /health targets were handed to it (MONITOR_HEALTH is unset in this gate's environment and no --health was given)",
};

/** The registry the monitor reads by default; the House vaults it should watch come from the same file. */
export const DEFAULT_REGISTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "markets", "tier1.json");

/**
 * The monitor this gate runs, next to it: ops/v2/monitor.mjs in the repo, /app/ops/v2/monitor.mjs in the keeper
 * image. Resolved from this file rather than the working directory, so the gate runs from any directory (`railway ssh`
 * does not promise one). The image test (prelaunch-gate-image.test.mjs) holds the Dockerfile to copying it.
 */
export const MONITOR_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "v2", "monitor.mjs");

/** The indexer's answer when PRICING_URL is unset (indexer/src/api/v2/markets.ts:314-320). */
export const PRICING_NOT_CONFIGURED = "Pricing service is not configured";

export function parseArgs(argv) {
  const out = {
    evidence: null, relayUrl: null, pricingUrl: null, indexerUrl: null, longId: null,
    notifierUrl: null, rpc: null, chainId: EXPECTED_CHAIN_ID, json: false, help: false, execute: false,
    timeoutMs: 10_000, registry: DEFAULT_REGISTRY,
    // The monitor's /health targets, the NAME of the variable holding the RPC, and the evidence JSON inline.
    health: null, rpcEnv: null, evidenceB64: null,
  };
  const fail = (m) => { throw new Error(m); };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    switch (arg) {
      case "--evidence": out.evidence = value(); break;
      case "--evidence-b64": out.evidenceB64 = value(); break;
      case "--health": out.health = value(); break;
      case "--rpc-env": out.rpcEnv = value(); break;
      case "--relay-url": out.relayUrl = value(); break;
      case "--pricing-url": out.pricingUrl = value(); break;
      case "--indexer-url": out.indexerUrl = value(); break;
      case "--long-id": out.longId = value(); break;
      case "--notifier-url": out.notifierUrl = value(); break;
      case "--rpc": out.rpc = value(); break;
      case "--registry": out.registry = value(); break;
      case "--chain-id": out.chainId = Number(value()); break;
      case "--timeout-ms": out.timeoutMs = Number(value()); break;
      case "--json": out.json = true; break;
      case "--execute": out.execute = true; break;
      case "--help": case "-h": out.help = true; break;
      default: fail(`unknown argument: ${arg}`);
    }
  }
  // One source per input: two would leave which one the gate judged to a precedence rule nobody reads.
  if (out.evidence !== null && out.evidenceB64 !== null) fail("give --evidence <path> or --evidence-b64 <base64>, not both");
  if (out.rpc !== null && out.rpcEnv !== null) fail("give --rpc <url> or --rpc-env <NAME>, not both");
  if (out.rpcEnv !== null && !/^[A-Z_][A-Z0-9_]*$/.test(out.rpcEnv)) fail(`--rpc-env takes a variable NAME, not ${JSON.stringify(out.rpcEnv)}`);
  if (out.health !== null) {
    // The MONITOR_HEALTH format (monitor.mjs parseNamedList): NAME=URL, comma-separated. The monitor validates each URL.
    const parts = out.health.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0 || parts.some((p) => p.indexOf("=") <= 0)) fail(`--health takes NAME=URL[,NAME=URL...], got ${JSON.stringify(out.health)}`);
  }
  return out;
}

/**
 * The refusal that keeps "read-only" true by construction.
 *
 * A script that acts by default is a defect. This one has no
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

/**
 * The evidence JSON handed inline as base64, for a container that has no copy of the file. The same reasons
 * as loadEvidence: an empty, non-base64 or malformed input is a named error, never an absent evidence set. Node's base64
 * decoder skips characters it does not know, so the alphabet is checked first: a truncated or mangled argument must
 * not decode to something that happens to parse.
 */
export function decodeEvidenceB64(b64) {
  const text = String(b64 ?? "").trim();
  if (text === "") return { error: "--evidence-b64 is empty" };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return { error: "--evidence-b64 is not base64" };
  return loadEvidence("--evidence-b64", { readFile: () => Buffer.from(text, "base64").toString("utf8") });
}

/* ---------------------------------------------------------------------------------------------
 * The four criteria. Each is a pure function of an observation, so the tests drive them without a
 * network and without a live service. Each returns exactly one row: there is no skip.
 * ------------------------------------------------------------------------------------------- */

/**
 * 1. A test alert was RECEIVED (the go-live checklist).
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
 * 2. `monitor --once` is clean against production (the go-live checklist).
 *
 * THE TRAP IS THE DEFINITION OF CLEAN, and it is neither "exit 0" nor "exit != 0 is bad". While
 * KeeperRewards and MakerVault hold 0, clean means exit 1 carrying EXACTLY the two standing names and
 * NO THIRD. A gate written as `exit === 0` reads FAIL forever and gets waived by hand; a gate written
 * as "exit 1 is fine" reads PASS through a real finding. Both names must be present AND nothing else.
 */
export function criterionMonitorOnce({ monitorRun, rpc, rpcEnv, chainId, healthTargets }) {
  const id = "own8-02.monitor.once-clean";
  const title = "`monitor --once` is clean against production";
  if (!rpc) {
    if (rpcEnv) {
      return fail(id, title, `--rpc-env ${rpcEnv} names a variable that is unset or empty here, so the monitor was never run`,
        `run the gate where ${rpcEnv} holds the RPC (the monitor service sets RH_RPC), or pass --rpc`);
    }
    return fail(id, title, "no --rpc given, so the monitor was never run",
      "pass --rpc \"$RH_RPC\" (ops/deploy.md:2045)");
  }
  if (chainId !== EXPECTED_CHAIN_ID) {
    return fail(id, title, `--chain-id ${chainId} is not ${EXPECTED_CHAIN_ID}: a clean monitor pass against the wrong chain proves nothing`,
      `re-run against chain ${EXPECTED_CHAIN_ID}, or correct --rpc`);
  }
  // What the gate handed the monitor's `health` check is known here, before the monitor answers. With no
  // --health and no MONITOR_HEALTH the monitor probes no service, whatever its report says about the check.
  if (typeof healthTargets !== "string" || healthTargets.trim() === "") {
    return fail(id, title, "the monitor was handed no /health targets (no --health, and MONITOR_HEALTH is unset in this gate's environment), so no service was asked whether it is up",
      "pass --health with the list ops/v2/go-live-gating.mjs prints for the monitor service (stonkctl prelaunch-gate does), "
      + "or export MONITOR_HEALTH, then re-run");
  }
  if (!monitorRun || monitorRun.ran !== true) {
    return fail(id, title, `the monitor did not run: ${monitorRun?.error ?? "no result"}`,
      "check ops/v2/monitor.mjs exists at this SHA and that --rpc answers; an unrun monitor is not a clean monitor");
  }
  // An exit code the report did not carry is unknown. Number(undefined) is NaN, and NaN !== 0 read as "a
  // standing page set the exit code" below, so a report with no exit passed with the two standing names.
  if (!Number.isInteger(monitorRun.exitCode)) {
    return fail(id, title, `the monitor's exit code could not be read (${monitorRun.exitCode}): whether its findings set it is unknown`,
      "check the monitor's --json `exit` field; do not treat an unread exit as clean");
  }
  // monitor.mjs:3517 exitCodeFor ranks an INCOMPLETE CHECK (exit 3) above a finding (exit 1), and it
  // is the more dangerous of the two here: a check that could not complete has no findings to show,
  // so a gate that only counted alert names would read it as clean.
  if (Number(monitorRun.incompleteChecks ?? 0) > 0) {
    return fail(id, title, `the monitor reported ${monitorRun.incompleteChecks} incomplete check(s): a check that could not run has no findings to show, so silence from it is not cleanliness`,
      "read the monitor's `note:` lines for the incomplete check and fix its input before judging this gate");
  }
  if (!Array.isArray(monitorRun.skippedChecks)) {
    return fail(id, title, "the monitor ran but which of its checks were skipped could not be read: a skipped check counts as completed, so an unread list is not a clean run",
      "check the monitor's --json `checks` object; do not treat an unreadable report as clean");
  }
  const skippedLaunch = MONITOR_LAUNCH_CHECKS.filter((name) => monitorRun.skippedChecks.includes(name));
  if (skippedLaunch.length > 0) {
    return fail(id, title, `the monitor skipped ${skippedLaunch.join(" and ")}: ${skippedLaunch.map((n) => SKIP_REASON[n]).join("; ")}. A skipped check reads as completed and finds nothing`,
      "pass --pricing-url, pass --health or export MONITOR_HEALTH (the list ops/v2/go-live-gating.mjs prints for the monitor service), and "
      + "run the launch's window step so the registry's market rows name their House vaults, then re-run");
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
 * 3. `/fair` answers for a live NVDA series (the go-live checklist).
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
 * (the go-live checklist).
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
    // The notifications spec gates production on "every expected message arrived ONCE".
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
       [--registry ops/markets/tier1.json] [--json] [--timeout-ms 10000]

  --health NAME=URL[,...]   the monitor's /health targets (MONITOR_HEALTH format); default: this process's MONITOR_HEALTH
  --rpc-env NAME            read the RPC from variable NAME instead of --rpc (inside the monitor service: RH_RPC)
  --evidence-b64 <base64>   the evidence JSON inline, instead of --evidence <path>

One line per OWN8-02 criterion, PASS or FAIL, and on FAIL the exact next action. Exits non-zero
unless all four PASS. Read-only: it sends no alert, opens no subscription and writes to no service.
An unconfigured or unreachable service reads FAIL with the reason -- never PASS, never skipped.`;

/** MONITOR_HOUSE_VAULTS for a registry file, or "" when it cannot be read (the monitor then reports `house` skipped). */
function houseVaultsFor(registryPath) {
  try { return monitorHouseVaults(JSON.parse(readFileSync(registryPath, "utf8"))); } catch { return ""; }
}

/**
 * The audit trigger as the monitor's `--threshold` value (`auditTriggerUsdg=…`), from the same
 * go-live-gating.mjs monitorThresholds that go-live-v2.sh sets as MONITOR_THRESHOLDS, or "" when the
 * registry cannot express it. Without it the gate's monitor run has auditTriggerUsdg 0, and on a funded launch it
 * carries v2_mon_tvl_audit_trigger (off while funded) at error, which the production monitor never pages.
 */
function auditThresholdFor(registryPath) {
  try {
    const { line } = monitorThresholds(JSON.parse(readFileSync(registryPath, "utf8")));
    return line.replace(/^MONITOR_THRESHOLDS=/, "");
  } catch { return ""; }
}

/** Gather every observation, then evaluate. Probes are injected so the tests need no network. */
export async function gather(opts, probes = {}) {
  const env = probes.env ?? process.env;
  const get = probes.httpJson ?? ((url) => httpJson(url, { timeoutMs: opts.timeoutMs }));
  const runMonitor = probes.runMonitor ?? ((o) => runMonitorOnce(o, { execFile: defaultExecFile, env }));
  const evidenceRead = opts.evidenceB64 !== null && opts.evidenceB64 !== undefined
    ? decodeEvidenceB64(opts.evidenceB64)
    : loadEvidence(opts.evidence, probes.evidenceIo ?? {});
  // --rpc-env reads the RPC from this process's environment; an unset or empty variable is no RPC (FAIL).
  const rpc = opts.rpcEnv ? (env[opts.rpcEnv] || null) : opts.rpc;
  // What the monitor's `health` check will probe: --health, else the MONITOR_HEALTH the child inherits.
  const healthTargets = opts.health ?? env.MONITOR_HEALTH ?? "";
  const [relayHealth, pricingHealth, notifierHealth, fairResponse, monitorRun] = await Promise.all([
    opts.relayUrl ? get(`${opts.relayUrl.replace(/\/$/, "")}/health`) : null,
    opts.pricingUrl ? get(`${opts.pricingUrl.replace(/\/$/, "")}/health`) : null,
    opts.notifierUrl ? get(`${opts.notifierUrl.replace(/\/$/, "")}/health`) : null,
    opts.indexerUrl && opts.longId
      ? get(`${opts.indexerUrl.replace(/\/$/, "")}/v2/fair/${encodeURIComponent(opts.longId)}`)
      : null,
    rpc ? runMonitor({ ...opts, rpc, houseVaults: houseVaultsFor(opts.registry), thresholds: auditThresholdFor(opts.registry) }) : null,
  ]);
  return {
    ...opts,
    rpc,
    healthTargets,
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
 * The real monitor runner: `node ops/v2/monitor.mjs --once --no-alerts --json`, plus
 * `--pricing <pricing url>` and `--house <TICKER=0x…,…>` whenever the gate has them, so the pricing and House checks
 * run instead of reporting themselves skipped, and the registry the monitor reads is the one the House vaults came from.
 * And `--threshold auditTriggerUsdg=…` from that registry, the value go-live sets on the monitor service, so
 * the gate's run judges the audit trigger the production monitor runs with rather than the off-while-funded default 0.
 *
 * --no-alerts is what keeps this read-only: the monitor computes its findings and sends nothing
 * (its `how()` renders them DRY). --json is parsed rather than the `summary:` line scraped, because a
 * regex over prose is a check that quietly stops matching. A non-zero exit is NOT an error here: the
 * monitor uses exit 1 for findings and exit 3 for incomplete checks, and criterionMonitorOnce is what
 * decides which of those is clean. What IS an error is output this cannot parse -- reported as such,
 * never as an empty finding list, which would read as clean.
 */
/*
 * The RPC reaches the child as RH_RPC in its environment (monitor.mjs reads env.RH_RPC), never as `--rpc`: a
 * keyed URL on a command line is visible to every process listing, and execFile's error message quotes the whole command
 * line, which criterionMonitorOnce prints. --health (opts.health) REPLACES the inherited MONITOR_HEALTH rather than adding
 * `--health` flags, which monitor.mjs appends to the environment's list, so each target is probed once. For the same
 * reason, when the gate hands `--house` it clears an inherited MONITOR_HOUSE_VAULTS: inside the monitor service go-live
 * set that variable from the same registry, and monitor.mjs would read every House vault twice.
 */
export async function runMonitorOnce(opts, { execFile, monitorPath = MONITOR_PATH, env = process.env } = {}) {
  if (!execFile) return { ran: false, error: "no process runner supplied" };
  const childEnv = {
    ...env, RH_RPC: opts.rpc,
    ...(opts.health ? { MONITOR_HEALTH: opts.health } : {}),
    ...(opts.houseVaults ? { MONITOR_HOUSE_VAULTS: "" } : {}),
  };
  let stdout;
  try {
    stdout = await execFile(process.execPath, [
      monitorPath, "--once", "--no-alerts", "--json",
      ...(opts.registry ? ["--registry", opts.registry] : []),
      ...(opts.pricingUrl ? ["--pricing", opts.pricingUrl.replace(/\/$/, "")] : []),
      ...(opts.houseVaults ? ["--house", opts.houseVaults] : []),
      ...(opts.thresholds ? ["--threshold", opts.thresholds] : []),
    ], { env: childEnv });
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
  const skippedChecks = report.checks !== null && typeof report.checks === "object"
    ? Object.entries(report.checks).filter(([, c]) => c?.status === "skipped").map(([name]) => name).sort()
    : null;
  return {
    ran: true,
    exitCode: Number.isInteger(report.exit) ? report.exit : null,
    alerts: [...new Set(report.findings.map((f) => f.kind))].sort(),
    incompleteChecks: report.incompleteChecks.length,
    skippedChecks,
    deliveryFailures: Number(report.deliveryFailures ?? 0),
  };
}
