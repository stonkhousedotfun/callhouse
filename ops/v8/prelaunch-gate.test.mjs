/**
 * node --test ops/v8/prelaunch-gate.test.mjs
 *
 * Every observation here is INJECTED. Nothing in this file contacts a service, and the one test that
 * opens a socket points at a closed port on 127.0.0.1 — that is the point of it.
 *
 * THE GREEN CONTROL IS ASSERTED FIRST, on purpose. A gate proved only by its refusals may be refusing
 * everything, and "4 of 4 FAILED" from a tool that can never say PASS is the same worthless artifact
 * as a check that can never say FAIL.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ORDER, monitorHealth, monitorHouseVaults, monitorThresholds } from "../v2/go-live-gating.mjs";
import {
  CRITERIA_ORDER, DEFAULT_REGISTRY, EXPECTED_CHAIN_ID, EXPECTED_EXPIRY_MESSAGES, MONITOR_KNOWN_STANDING,
  MONITOR_LAUNCH_CHECKS, MONITOR_PATH, PRICING_NOT_CONFIGURED, allPassed, criterionFair, criterionMonitorOnce,
  criterionNotifierExpiry, criterionTestAlert, decodeEvidenceB64, evaluate, gather, httpJson, loadEvidence, main,
  parseArgs, refuseExecute, render, runMonitorOnce,
} from "./prelaunch-gate.mjs";

const up = (body = { status: "ok" }) => ({ ok: true, status: 200, body, text: JSON.stringify(body) });
const dead = { ok: false, status: null, body: null, text: "", error: "connect ECONNREFUSED" };

const GOOD_EVIDENCE = {
  testAlert: { status: 200, delivered: ["discord"], failed: [], seenInChannel: true, at: "2026-09-21T20:00:00Z" },
  dailyExpiry: {
    telegram: [...EXPECTED_EXPIRY_MESSAGES], browser: [...EXPECTED_EXPIRY_MESSAGES],
    breakerOpened: false, rulesStatus: "ok", xffTestPassed: true, expiry: "2026-09-21T16:00-04:00",
  },
};

const FAIR = { source: "cboe", asOf: "2026-09-21T19:59:00Z", amount: "1234", decimals: 6 };

/** Every observation good: the shape that must reach 4/4 PASS. */
const green = (over = {}) => ({
  relayUrl: "http://relay.railway.internal:8080",
  pricingUrl: "http://pricing.railway.internal:8790",
  indexerUrl: "https://indexer.example", longId: "NVDA-20260921-C-100",
  notifierUrl: "https://dev-notify.example",
  rpc: "http://rpc.example", chainId: EXPECTED_CHAIN_ID,
  healthTargets: "relay=http://relay.railway.internal:8080/health",
  relayHealth: up(), pricingHealth: up(), notifierHealth: up(),
  fairResponse: up(FAIR),
  monitorRun: { ran: true, exitCode: 1, alerts: [...MONITOR_KNOWN_STANDING], incompleteChecks: 0, skippedChecks: [], deliveryFailures: 0 },
  evidence: structuredClone(GOOD_EVIDENCE),
  ...over,
});

describe("the green control", () => {
  test("every criterion PASSes when every observation is good", () => {
    const rows = evaluate(green());
    assert.deepEqual(rows.map((r) => r.status), ["PASS", "PASS", "PASS", "PASS"],
      `expected 4 PASS, got:\n${render(rows)}`);
    assert.equal(allPassed(rows), true);
    assert.deepEqual(rows.map((r) => r.id), CRITERIA_ORDER);
  });

  test("a clean monitor with no alerts at all also PASSes", () => {
    // Once KeeperRewards and MakerVault hold a budget, clean becomes exit 0 with no names. Both
    // shapes must pass, or the gate has to be edited on the day the standing pages clear.
    const rows = evaluate(green({ monitorRun: { ran: true, exitCode: 0, alerts: [], incompleteChecks: 0, skippedChecks: [], deliveryFailures: 0 } }));
    assert.equal(allPassed(rows), true, render(rows));
  });

  test("every PASS row carries no next action, every FAIL row carries one", () => {
    for (const row of evaluate(green())) assert.equal(row.nextAction, null, row.id);
    for (const row of evaluate({ chainId: EXPECTED_CHAIN_ID })) {
      assert.equal(row.status, "FAIL", row.id);
      assert.ok(row.nextAction && row.nextAction.length > 0, `${row.id} FAILs with no next action`);
      assert.ok(row.detail && row.detail.length > 0, `${row.id} FAILs with no reason`);
    }
  });
});

describe("unconfigured and unreachable both read FAIL", () => {
  test("nothing configured: four FAILs, never a skip and never a pass", () => {
    const rows = evaluate({ chainId: EXPECTED_CHAIN_ID });
    assert.equal(rows.length, CRITERIA_ORDER.length);
    assert.deepEqual([...new Set(rows.map((r) => r.status))], ["FAIL"]);
  });

  test("a dead endpoint FAILs even when the recorded evidence is perfect", () => {
    // The evidence file must never rescue a service nobody could reach: that is the "PASS because no
    // error" shape this gate exists to refuse.
    const rows = evaluate(green({ relayHealth: dead, pricingHealth: dead, notifierHealth: dead, fairResponse: dead }));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId["own8-02.relay.test-alert"].status, "FAIL");
    assert.equal(byId["own8-02.pricing.fair"].status, "FAIL");
    assert.equal(byId["own8-02.notifier.daily-expiry"].status, "FAIL");
    for (const r of rows) if (r.status === "FAIL") assert.match(r.detail, /unreachable|no --|did not run/);
  });

  test("a real closed port on this machine reads unreachable, not ok", async () => {
    // The one socket in this file. 127.0.0.1 only: nothing leaves the machine.
    const res = await httpJson("http://127.0.0.1:59437/health", { timeoutMs: 1500 });
    assert.equal(res.ok, false, "a closed port must not answer ok");
    assert.equal(res.status, null);
    assert.ok(res.error.length > 0);
    assert.equal(criterionTestAlert({ relayUrl: "http://127.0.0.1:59437", relayHealth: res, evidence: GOOD_EVIDENCE }).status, "FAIL");
  });

  test("a 200 with an unhealthy body is not a healthy service", () => {
    assert.equal(criterionFair({ ...green(), pricingHealth: up({ status: "degraded" }) }).status, "FAIL");
    assert.equal(criterionNotifierExpiry({ ...green(), notifierHealth: up({ status: "starting" }) }).status, "FAIL");
  });
});

describe("criterion 1 — a test alert was RECEIVED", () => {
  test("a live relay with no recorded receipt is FAIL, not PASS", () => {
    const row = criterionTestAlert({ ...green(), evidence: {} });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /a live relay is not a delivered message/);
  });

  test("a 200 that delivered to nobody is FAIL — the packet says a 200 alone is not enough", () => {
    const evidence = structuredClone(GOOD_EVIDENCE);
    evidence.testAlert.delivered = [];
    assert.match(criterionTestAlert({ ...green(), evidence }).detail, /delivered is empty/);
  });

  test("a partial delivery is FAIL", () => {
    const evidence = structuredClone(GOOD_EVIDENCE);
    evidence.testAlert.failed = ["telegram"];
    assert.match(criterionTestAlert({ ...green(), evidence }).detail, /failed is \["telegram"\]/);
  });

  test("nobody attesting they SAW the message is FAIL", () => {
    const evidence = structuredClone(GOOD_EVIDENCE);
    delete evidence.testAlert.seenInChannel;
    assert.match(criterionTestAlert({ ...green(), evidence }).detail, /seenInChannel/);
  });
});

describe("criterion 2 — what `clean` actually means", () => {
  const monitor = (over) => criterionMonitorOnce(green({ monitorRun: { ran: true, exitCode: 1, alerts: [], incompleteChecks: 0, skippedChecks: [], deliveryFailures: 0, ...over } }));

  test("exactly the two known standing pages is clean, despite exit 1", () => {
    assert.equal(monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 1 }).status, "PASS");
  });

  test("a THIRD name is not clean, and it is named", () => {
    const row = monitor({ alerts: [...MONITOR_KNOWN_STANDING, "v2_mon_settlement_late"], exitCode: 1 });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /v2_mon_settlement_late/);
  });

  test("one expected name swapped for one unexpected name is not clean — a count would have passed it", () => {
    const row = monitor({ alerts: [MONITOR_KNOWN_STANDING[0], "v2_mon_token_paused"], exitCode: 1 });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /v2_mon_token_paused/);
  });

  test("a SUBSET of the standing pages is not clean either", () => {
    const row = monitor({ alerts: [MONITOR_KNOWN_STANDING[0]], exitCode: 1 });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, new RegExp(MONITOR_KNOWN_STANDING[1]));
  });

  test("an incomplete check is NOT clean — it has no findings to show", () => {
    // monitor.mjs:3517 ranks incompleteChecks (exit 3) above findings (exit 1). A gate counting only
    // alert names would read a check that could not run as silence, and silence as health.
    const row = monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 3, incompleteChecks: 2 });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /incomplete check/);
  });

  test("a delivery failure is not clean", () => {
    assert.equal(monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 4, deliveryFailures: 1 }).status, "FAIL");
  });

  test("the exit code and the summary disagreeing is FAIL, both directions", () => {
    assert.equal(monitor({ alerts: [], exitCode: 1 }).status, "FAIL");
    assert.equal(monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 0 }).status, "FAIL");
  });

  test("an unrun or unparsable monitor is FAIL, never an empty alert list read as clean", () => {
    assert.equal(criterionMonitorOnce(green({ monitorRun: { ran: false, error: "spawn failed" } })).status, "FAIL");
    assert.equal(criterionMonitorOnce(green({ monitorRun: { ran: true, exitCode: 0, alerts: null } })).status, "FAIL");
  });

  test("A skipped House or pricing check is NOT clean — the monitor counts a skip as completed", () => {
    for (const skipped of [["house"], ["pricing"], ["house", "pricing", "divergence"]]) {
      const row = monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 1, skippedChecks: skipped });
      assert.equal(row.status, "FAIL", skipped.join(","));
      for (const name of skipped.filter((n) => MONITOR_LAUNCH_CHECKS.includes(n))) assert.match(row.detail, new RegExp(`\\b${name}\\b`));
    }
    // A check outside the launch set may still be skipped (e.g. divergence bands are not calibrated yet).
    // `health` is no longer outside it (this line used to pass ["divergence", "health"]); see the health test below.
    assert.equal(monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 1, skippedChecks: ["divergence"] }).status, "PASS");
    // And a run whose skipped list could not be read is not clean either.
    assert.equal(monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 1, skippedChecks: undefined }).status, "FAIL");
  });

  test("A skipped health check is NOT clean — no service was asked anything", () => {
    // Only `health` skipped; house and pricing ran, the alerts are exactly the two standing pages, exit 1.
    const row = monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 1, skippedChecks: ["health"] });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /skipped health: no \/health targets were handed to it \(MONITOR_HEALTH is unset/);
    assert.match(row.nextAction, /export MONITOR_HEALTH/);
    // The control: the same run with health completed passes.
    assert.equal(monitor({ alerts: [...MONITOR_KNOWN_STANDING], exitCode: 1, skippedChecks: [] }).status, "PASS");
  });

  test("A monitor report with no exit code is not clean, even with exactly the two standing pages", async () => {
    // The report is complete in every other way; only `exit` is missing.
    const r = await runMonitorOnce({ rpc: "http://rpc.example" }, {
      execFile: async () => JSON.stringify({ findings: MONITOR_KNOWN_STANDING.map((kind) => ({ kind })), incompleteChecks: [], deliveryFailures: 0,
        checks: { house: { status: "ok" }, pricing: { status: "ok" }, health: { status: "ok" } } }),
    });
    assert.equal(r.ran, true);
    assert.equal(r.exitCode, null);
    const row = monitor({ ...r });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /exit code could not be read/);
    // The control: the same report with its exit (1: the standing pages) passes.
    assert.equal(monitor({ ...r, exitCode: 1 }).status, "PASS");
  });

  test("a clean pass against the wrong chain proves nothing", () => {
    const row = criterionMonitorOnce(green({ chainId: 1 }));
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, new RegExp(String(EXPECTED_CHAIN_ID)));
  });
});

describe("criterion 3 — /fair, not PRICING_URL", () => {
  test("the not-configured string is FAIL and names PRICING_URL", () => {
    const row = criterionFair({ ...green(), fairResponse: { ok: true, status: 200, body: null, text: `{"error":"${PRICING_NOT_CONFIGURED}"}` } });
    assert.equal(row.status, "FAIL");
    assert.match(row.nextAction, /PRICING_URL/);
  });

  test("a 200 Money with no provenance is FAIL", () => {
    for (const drop of ["source", "asOf"]) {
      const money = { ...FAIR };
      delete money[drop];
      const row = criterionFair({ ...green(), fairResponse: up(money) });
      assert.equal(row.status, "FAIL", drop);
      assert.match(row.detail, new RegExp(drop));
    }
  });

  test("a config value alone never satisfies it: the observation is the answer", () => {
    // There is deliberately no --pricing-url-is-set style input. The only route to PASS is a body.
    assert.equal(criterionFair({ ...green(), fairResponse: null }).status, "FAIL");
  });
});

describe("criterion 4 — the daily-expiry soak", () => {
  test("a healthy notifier with no recorded soak is FAIL", () => {
    const row = criterionNotifierExpiry({ ...green(), evidence: {} });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /a healthy notifier is not a delivered alert/);
  });

  test("one channel missing one message is FAIL, and both are named", () => {
    const evidence = structuredClone(GOOD_EVIDENCE);
    evidence.browser = undefined;
    evidence.dailyExpiry.browser = ["reminder1h", "settlementReceipt"];
    const row = criterionNotifierExpiry({ ...green(), evidence });
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /browser is missing fillReceipt/);
  });

  test("a duplicated message is FAIL — production is gated on each arriving ONCE", () => {
    const evidence = structuredClone(GOOD_EVIDENCE);
    evidence.dailyExpiry.telegram = [...EXPECTED_EXPIRY_MESSAGES, "fillReceipt"];
    assert.match(criterionNotifierExpiry({ ...green(), evidence }).detail, /more than once/);
  });

  test("an opened breaker, a non-ok rules.status and a missing XFF test are each FAIL", () => {
    for (const [k, v] of [["breakerOpened", true], ["rulesStatus", "degraded"], ["xffTestPassed", false]]) {
      const evidence = structuredClone(GOOD_EVIDENCE);
      evidence.dailyExpiry[k] = v;
      assert.equal(criterionNotifierExpiry({ ...green(), evidence }).status, "FAIL", k);
    }
  });
});

describe("the evidence file itself", () => {
  test("no path, a missing file and malformed JSON are each a named reason, never an absence", () => {
    assert.match(loadEvidence(null).error, /no --evidence/);
    assert.match(loadEvidence("/nonexistent/evidence.json").error, /cannot read/);
    assert.match(loadEvidence("x", { readFile: () => "{" }).error, /not valid JSON/);
    assert.match(loadEvidence("x", { readFile: () => "[]" }).error, /not a JSON object/);
  });
});

describe("it never acts", () => {
  test("--execute is refused and the process exits non-zero", async () => {
    assert.match(refuseExecute({ execute: true }), /refused/);
    assert.equal(refuseExecute({ execute: false }), null);
    const err = [];
    assert.equal(await main(["--execute"], { log: () => {}, err: (s) => err.push(s) }), 2);
    assert.match(err.join("\n"), /only OBSERVES/);
  });

  test("the monitor is run with --no-alerts and --json, and never with a send flag", async () => {
    let seen = null;
    await runMonitorOnce({ rpc: "http://rpc.example" }, {
      execFile: async (_cmd, args) => { seen = args; return JSON.stringify({ findings: [], incompleteChecks: [], deliveryFailures: 0, exit: 0 }); },
    });
    assert.ok(seen.includes("--no-alerts"), "the monitor must not be allowed to send");
    assert.ok(seen.includes("--json"));
    assert.ok(seen.includes("--once"));
    assert.equal(seen.includes("--apply"), false);
  });

  test("The monitor gets the gate's pricing URL, the registry and its House vaults, and reports what it skipped", async () => {
    let seen = null;
    const r = await runMonitorOnce({ rpc: "http://rpc.example", pricingUrl: "http://pricing.railway.internal:8790/", registry: "/r/tier1.json", houseVaults: "NVDA=0x" + "1".repeat(40) }, {
      execFile: async (_cmd, args) => {
        seen = args;
        return JSON.stringify({ findings: [], incompleteChecks: [], deliveryFailures: 0, exit: 0, checks: { house: { status: "ok" }, pricing: { status: "skipped" }, divergence: { status: "skipped" }, scan: { status: "ok" } } });
      },
    });
    const after = (flag) => seen[seen.indexOf(flag) + 1];
    assert.equal(after("--pricing"), "http://pricing.railway.internal:8790");
    assert.equal(after("--registry"), "/r/tier1.json");
    assert.equal(after("--house"), "NVDA=0x" + "1".repeat(40));
    assert.deepEqual(r.skippedChecks, ["divergence", "pricing"]);
    // Nothing to hand in: no flag at all rather than an empty value the monitor would refuse.
    await runMonitorOnce({ rpc: "x" }, { execFile: async (_cmd, args) => { seen = args; return JSON.stringify({ findings: [], incompleteChecks: [], exit: 0 }); } });
    assert.equal(seen.includes("--pricing") || seen.includes("--house"), false);
  });

  test("Gather hands the monitor the House vaults the registry names", async () => {
    let handed = null;
    await gather({ ...parseArgs(["--rpc", "http://rpc.example", "--pricing-url", "http://pricing.railway.internal:8790"]) }, {
      httpJson: async () => up(),
      runMonitor: async (o) => { handed = o; return { ran: true, exitCode: 0, alerts: [], incompleteChecks: 0, skippedChecks: [], deliveryFailures: 0 }; },
    });
    const registry = JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8"));
    assert.equal(handed.houseVaults, monitorHouseVaults(registry));
    assert.match(handed.houseVaults, /^NVDA=0x[0-9a-fA-F]{40}.*SPCX=0x[0-9a-fA-F]{40}/, "the shipped registry names the launch set's House vaults");
  });

  test("The monitor run gets the audit trigger go-live sets, not the off-while-funded default 0", async () => {
    let handed = null;
    await gather({ ...parseArgs(["--rpc", "http://rpc.example"]) }, {
      httpJson: async () => up(),
      runMonitor: async (o) => { handed = o; return { ran: true, exitCode: 0, alerts: [], incompleteChecks: 0, skippedChecks: [], deliveryFailures: 0 }; },
    });
    const registry = JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8"));
    // The same line go-live-v2.sh sets as MONITOR_THRESHOLDS on the monitor service, minus its name.
    const line = monitorThresholds(registry).line;
    assert.match(line, /^MONITOR_THRESHOLDS=auditTriggerUsdg=[1-9][0-9]*$/, "the shipped registry expresses the audit trigger");
    assert.equal(`MONITOR_THRESHOLDS=${handed.thresholds}`, line);

    let seen = null;
    await runMonitorOnce({ rpc: "x", thresholds: handed.thresholds }, {
      execFile: async (_cmd, args) => { seen = args; return JSON.stringify({ findings: [], incompleteChecks: [], exit: 0 }); },
    });
    assert.equal(seen[seen.indexOf("--threshold") + 1], handed.thresholds);

    // A registry the tool cannot read hands no threshold, and the monitor gets no flag rather than an empty value.
    await gather({ ...parseArgs(["--rpc", "http://rpc.example", "--registry", "/nonexistent/tier1.json"]) }, {
      httpJson: async () => up(),
      runMonitor: async (o) => { handed = o; return { ran: true, exitCode: 0, alerts: [], incompleteChecks: 0, skippedChecks: [], deliveryFailures: 0 }; },
    });
    assert.equal(handed.thresholds, "");
    await runMonitorOnce({ rpc: "x", thresholds: "" }, {
      execFile: async (_cmd, args) => { seen = args; return JSON.stringify({ findings: [], incompleteChecks: [], exit: 0 }); },
    });
    assert.equal(seen.includes("--threshold"), false);
  });

  test("a monitor that answers prose instead of JSON is unrun, not clean", async () => {
    const r = await runMonitorOnce({ rpc: "x" }, { execFile: async () => "summary: 0 finding(s); exit 0" });
    assert.equal(r.ran, false);
    assert.match(r.error, /refusing to guess/);
  });

  test("a non-zero monitor exit is still parsed, because exit 1 is how clean looks today", async () => {
    const r = await runMonitorOnce({ rpc: "x" }, {
      execFile: async () => {
        const e = new Error("Command failed");
        e.stdout = JSON.stringify({ findings: MONITOR_KNOWN_STANDING.map((kind) => ({ kind })), incompleteChecks: [], deliveryFailures: 0, exit: 1 });
        throw e;
      },
    });
    assert.equal(r.ran, true);
    assert.deepEqual(r.alerts, [...MONITOR_KNOWN_STANDING].sort());
    assert.equal(r.exitCode, 1);
  });
});

describe("the command itself", () => {
  test("parseArgs refuses an unknown flag rather than ignoring it", () => {
    assert.throws(() => parseArgs(["--not-a-flag"]), /unknown argument/);
    assert.throws(() => parseArgs(["--relay-url"]), /needs a value/);
    assert.equal(parseArgs([]).chainId, EXPECTED_CHAIN_ID);
  });

  test("exit code is 0 only when all four PASS", async () => {
    const probes = {
      httpJson: async (url) => (url.includes("/v2/fair/") ? up(FAIR) : up()),
      runMonitor: async () => ({ ran: true, exitCode: 1, alerts: [...MONITOR_KNOWN_STANDING], incompleteChecks: 0, skippedChecks: [], deliveryFailures: 0 }),
      evidenceIo: { readFile: () => JSON.stringify(GOOD_EVIDENCE) },
    };
    // --health, because a monitor handed no /health targets is not clean (the gate knows what it handed).
    const argv = ["--evidence", "e.json", "--relay-url", "http://r", "--pricing-url", "http://p",
      "--indexer-url", "http://i", "--long-id", "L", "--notifier-url", "http://n", "--rpc", "http://rpc",
      "--health", "relay=http://r/health"];
    const out = [];
    assert.equal(await main(argv, { log: (s) => out.push(s), err: () => {}, probes }), 0);
    assert.match(out.join("\n"), /4\/4 PASS/);

    const out2 = [];
    assert.equal(await main(argv, {
      log: (s) => out2.push(s), err: () => {},
      probes: { ...probes, evidenceIo: { readFile: () => "{}" } },
    }), 1, "a missing soak must make the command exit non-zero");
  });

  test("evaluate refuses to return a short row set", () => {
    // The gate reporting three PASSes and calling it done is the defect this whole file is about.
    assert.equal(evaluate({ chainId: EXPECTED_CHAIN_ID }).length, CRITERIA_ORDER.length);
    assert.equal(allPassed([{ status: "PASS" }, { status: "PASS" }, { status: "PASS" }]), false);
  });
});

describe("The gate runs inside the monitor service", () => {
  const FULL = monitorHealth(ORDER);
  const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64");
  const report = JSON.stringify({ findings: [], incompleteChecks: [], deliveryFailures: 0, exit: 0 });
  const ranClean = { ran: true, exitCode: 0, alerts: [], incompleteChecks: 0, skippedChecks: [], deliveryFailures: 0 };

  test("parseArgs takes --health, --rpc-env and --evidence-b64, and refuses two sources for one input", () => {
    const o = parseArgs(["--health", FULL, "--rpc-env", "RH_RPC", "--evidence-b64", b64(GOOD_EVIDENCE)]);
    assert.equal(o.health, FULL);
    assert.equal(o.rpcEnv, "RH_RPC");
    assert.equal(o.evidenceB64, b64(GOOD_EVIDENCE));
    assert.throws(() => parseArgs(["--rpc", "http://x", "--rpc-env", "RH_RPC"]), /--rpc <url> or --rpc-env <NAME>, not both/);
    assert.throws(() => parseArgs(["--evidence", "e.json", "--evidence-b64", "e30="]), /not both/);
    assert.throws(() => parseArgs(["--rpc-env", "https://rpc.example/KEY"]), /variable NAME/);
    assert.throws(() => parseArgs(["--health", "relay"]), /--health takes NAME=URL/);
    assert.throws(() => parseArgs(["--health", ","]), /--health takes NAME=URL/);
  });

  test("--health reaches the monitor child as its MONITOR_HEALTH, replacing the one it would inherit", async () => {
    let seen = null;
    await runMonitorOnce({ rpc: "http://rpc.example", health: FULL }, {
      env: { MONITOR_HEALTH: "stale=http://old.internal/health", PATH: "/bin" },
      execFile: async (_cmd, args, o) => { seen = { args, env: o.env }; return report; },
    });
    assert.equal(seen.env.MONITOR_HEALTH, FULL);
    assert.equal(seen.env.PATH, "/bin", "the rest of the environment is inherited");
    assert.equal(seen.args.includes("--health"), false, "monitor.mjs appends --health to MONITOR_HEALTH; the env is replaced instead");
    // And gather hands it through, and records what the monitor was handed.
    let handed = null;
    const obs = await gather(parseArgs(["--rpc", "http://rpc.example", "--health", FULL]), {
      env: {}, httpJson: async () => up(), runMonitor: async (o) => { handed = o; return ranClean; },
    });
    assert.equal(handed.health, FULL);
    assert.equal(obs.healthTargets, FULL);
    assert.equal(criterionMonitorOnce(obs).status, "PASS", criterionMonitorOnce(obs).detail);
  });

  test("without --health the monitor child keeps this process's own MONITOR_HEALTH", async () => {
    let seen = null;
    await runMonitorOnce({ rpc: "http://rpc.example" }, {
      env: { MONITOR_HEALTH: FULL },
      execFile: async (_cmd, _args, o) => { seen = o.env; return report; },
    });
    assert.equal(seen.MONITOR_HEALTH, FULL);
    const obs = await gather(parseArgs(["--rpc", "http://rpc.example"]), {
      env: { MONITOR_HEALTH: FULL }, httpJson: async () => up(), runMonitor: async () => ranClean,
    });
    assert.equal(obs.healthTargets, FULL);
    assert.equal(criterionMonitorOnce(obs).status, "PASS", criterionMonitorOnce(obs).detail);
  });

  test("with neither, the monitor criterion FAILs by name, even when the monitor's report does not say `skipped`", async () => {
    // The stub reports every check completed: the gate must not take the monitor's word for a check it handed nothing.
    const obs = await gather(parseArgs(["--rpc", "http://rpc.example"]), {
      env: {}, httpJson: async () => up(), runMonitor: async () => ranClean,
    });
    assert.equal(obs.healthTargets, "");
    const row = criterionMonitorOnce(obs);
    assert.equal(row.status, "FAIL");
    assert.match(row.detail, /handed no \/health targets/);
    assert.match(row.nextAction, /--health/);
    // An empty --health value is refused at parse time; a blank MONITOR_HEALTH is still "none".
    const blank = await gather(parseArgs(["--rpc", "http://rpc.example"]), { env: { MONITOR_HEALTH: "  " }, httpJson: async () => up(), runMonitor: async () => ranClean });
    assert.equal(criterionMonitorOnce(blank).status, "FAIL");
    // And the health path stays: a monitor that reports health skipped is FAIL even with targets recorded.
    assert.equal(criterionMonitorOnce(green({ monitorRun: { ...ranClean, skippedChecks: ["health"] } })).status, "FAIL");
  });

  test("--rpc-env reads the RPC from the environment, and the RPC never reaches any command line", async () => {
    const KEYED = "https://rpc.example/v1/SECRETKEY123";
    let seen = null;
    const obs = await gather(parseArgs(["--rpc-env", "RH_RPC", "--health", FULL]), {
      env: { RH_RPC: KEYED },
      httpJson: async () => up(),
      runMonitor: (o) => runMonitorOnce(o, { env: { RH_RPC: "http://inherited.example" }, execFile: async (_cmd, args, x) => { seen = { args, env: x.env }; return report; } }),
    });
    assert.equal(obs.rpc, KEYED);
    assert.equal(seen.env.RH_RPC, KEYED, "the child gets the RPC the gate resolved, in its environment");
    assert.equal(seen.args.some((a) => a.includes("SECRETKEY123")), false, "a keyed RPC must never be on the monitor's argv");
    assert.equal(seen.args.includes("--rpc"), false);
    // A spawn failure's message quotes the command line; with the RPC in the env it carries no key.
    const r = await runMonitorOnce({ rpc: KEYED }, {
      env: {}, execFile: async (cmd, args) => { throw new Error(`Command failed: ${cmd} ${args.join(" ")}\nboom`); },
    });
    assert.equal(r.ran, false);
    assert.equal(r.error.includes("SECRETKEY123"), false, r.error);
    // An unset or empty variable is no RPC: FAIL by name, never a run against a default.
    for (const env of [{}, { RH_RPC: "" }]) {
      let ran = false;
      const none = await gather(parseArgs(["--rpc-env", "RH_RPC", "--health", FULL]), { env, httpJson: async () => up(), runMonitor: async () => { ran = true; return ranClean; } });
      assert.equal(ran, false, "no monitor run without an RPC");
      const row = criterionMonitorOnce(none);
      assert.equal(row.status, "FAIL");
      assert.match(row.detail, /--rpc-env RH_RPC names a variable that is unset or empty/);
    }
  });

  test("--evidence-b64 supplies both evidence criteria; an empty, non-base64 or malformed input is still FAIL", async () => {
    assert.deepEqual(decodeEvidenceB64(b64(GOOD_EVIDENCE)).evidence, GOOD_EVIDENCE);
    assert.match(decodeEvidenceB64("").error, /is empty/);
    assert.match(decodeEvidenceB64("not base64!").error, /not base64/);
    assert.match(decodeEvidenceB64(b64(GOOD_EVIDENCE).slice(0, -1)).error, /not base64/, "a truncated argument is refused, not half-decoded");
    assert.match(decodeEvidenceB64(b64("{")).error, /not valid JSON/);
    assert.match(decodeEvidenceB64(b64("[]")).error, /not a JSON object/);

    const probes = (evidenceArg) => ({
      argv: [...evidenceArg, "--relay-url", "http://r", "--pricing-url", "http://p", "--indexer-url", "http://i",
        "--long-id", "L", "--notifier-url", "http://n", "--rpc-env", "RH_RPC", "--health", FULL],
      io: {
        log: () => {}, err: () => {},
        probes: { env: { RH_RPC: "http://rpc" }, httpJson: async (url) => (url.includes("/v2/fair/") ? up(FAIR) : up()),
          runMonitor: async () => ({ ...ranClean, exitCode: 1, alerts: [...MONITOR_KNOWN_STANDING] }) },
      },
    });
    const good = probes(["--evidence-b64", b64(GOOD_EVIDENCE)]);
    const out = [];
    assert.equal(await main(good.argv, { ...good.io, log: (s) => out.push(s) }), 0, "the green control: evidence inline, RPC from env");
    assert.match(out.join("\n"), /4\/4 PASS/);
    for (const bad of [["--evidence-b64", "@@@@"], ["--evidence-b64", b64("{")], []]) {
      const run = probes(bad);
      const lines = [];
      const errs = [];
      assert.equal(await main(run.argv, { ...run.io, log: (s) => lines.push(s), err: (s) => errs.push(s) }), 1, JSON.stringify(bad));
      assert.match(lines.join("\n"), /2 of 4 FAILED \(own8-02\.relay\.test-alert, own8-02\.notifier\.daily-expiry\)/);
      assert.match(errs.join("\n"), /^evidence: /m);
    }
  });

  test("the House vaults the gate hands replace the monitor service's MONITOR_HOUSE_VAULTS, never add to it", async () => {
    // monitor.mjs appends --house entries to MONITOR_HOUSE_VAULTS with no dedupe; inside the monitor service go-live set
    // that variable from the same registry, so both at once read every vault twice.
    const vaults = "NVDA=0x" + "1".repeat(40);
    let seen = null;
    await runMonitorOnce({ rpc: "http://rpc.example", houseVaults: vaults }, {
      env: { MONITOR_HOUSE_VAULTS: vaults }, execFile: async (_cmd, args, o) => { seen = { args, env: o.env }; return report; },
    });
    assert.equal(seen.args[seen.args.indexOf("--house") + 1], vaults);
    assert.equal(seen.env.MONITOR_HOUSE_VAULTS, "");
    // Nothing handed: the inherited list stays, so the monitor still watches the vaults go-live gave it.
    await runMonitorOnce({ rpc: "http://rpc.example", houseVaults: "" }, {
      env: { MONITOR_HOUSE_VAULTS: vaults }, execFile: async (_cmd, args, o) => { seen = { args, env: o.env }; return report; },
    });
    assert.equal(seen.args.includes("--house"), false);
    assert.equal(seen.env.MONITOR_HOUSE_VAULTS, vaults);
  });

  test("the monitor it runs is the one next to it, whatever the working directory", () => {
    assert.ok(path.isAbsolute(MONITOR_PATH));
    assert.equal(MONITOR_PATH, path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "v2", "monitor.mjs"));
    assert.ok(existsSync(MONITOR_PATH), MONITOR_PATH);
  });
});
