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
import { describe, test } from "node:test";

import {
  CRITERIA_ORDER, EXPECTED_CHAIN_ID, EXPECTED_EXPIRY_MESSAGES, MONITOR_KNOWN_STANDING,
  PRICING_NOT_CONFIGURED, allPassed, criterionFair, criterionMonitorOnce, criterionNotifierExpiry,
  criterionTestAlert, evaluate, httpJson, loadEvidence, main, parseArgs, refuseExecute, render,
  runMonitorOnce,
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
  relayHealth: up(), pricingHealth: up(), notifierHealth: up(),
  fairResponse: up(FAIR),
  monitorRun: { ran: true, exitCode: 1, alerts: [...MONITOR_KNOWN_STANDING], incompleteChecks: 0, deliveryFailures: 0 },
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
    const rows = evaluate(green({ monitorRun: { ran: true, exitCode: 0, alerts: [], incompleteChecks: 0, deliveryFailures: 0 } }));
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
  const monitor = (over) => criterionMonitorOnce(green({ monitorRun: { ran: true, exitCode: 1, alerts: [], incompleteChecks: 0, deliveryFailures: 0, ...over } }));

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
      runMonitor: async () => ({ ran: true, exitCode: 1, alerts: [...MONITOR_KNOWN_STANDING], incompleteChecks: 0, deliveryFailures: 0 }),
      evidenceIo: { readFile: () => JSON.stringify(GOOD_EVIDENCE) },
    };
    const argv = ["--evidence", "e.json", "--relay-url", "http://r", "--pricing-url", "http://p",
      "--indexer-url", "http://i", "--long-id", "L", "--notifier-url", "http://n", "--rpc", "http://rpc"];
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
