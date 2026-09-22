/**
 * node --test ops/go-live-v2.test.mjs
 *
 * O3-004 service-gating. Does not invoke Railway, does not read ~/.callhouse-keys, does not
 * print secrets. The helper is the owner of the rules; the shell --plan-gating path is the
 * dry-run surface.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ORDER, RELAY_EXEMPT, RELAY_REQUIRED, SIGNING, monitorHealth, planGating,
} from "./v2/go-live-gating.mjs";

const OPS = path.dirname(fileURLToPath(import.meta.url));
const SH = path.join(OPS, "go-live-v2.sh");
const DEV_PROJECT = "d8952b22-6bd8-4fd7-984a-7868ee353879";
const DEV_ENV = "a87aa3a2-1c68-41e7-9866-d0e72810035b";

function planSh(args, env = {}) {
  return execFileSync("bash", [SH, "--plan-gating", "--offline", ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: process.env.PATH, ...env },
  });
}

function planShFail(args, env = {}) {
  let code = 0;
  let stderr = "";
  let stdout = "";
  try {
    stdout = execFileSync("bash", [SH, "--plan-gating", "--offline", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH, ...env },
    });
  } catch (e) {
    code = e.status;
    stderr = String(e.stderr);
    stdout = String(e.stdout);
  }
  return { code, stderr, stdout };
}

describe("rules", () => {
  test("relay is required only for pricer, mm-bot and monitor", () => {
    assert.deepEqual(RELAY_REQUIRED, ["pricer", "mm-bot", "monitor"]);
    for (const s of RELAY_REQUIRED) {
      assert.equal(planGating({ services: s, dev: false, existing: ["pricing"] }).decisions[0].requireRelay, true);
    }
  });
  test("pricing, notifier, indexer-v2 and cranker are relay-exempt", () => {
    assert.deepEqual(RELAY_EXEMPT, ["pricing", "notifier", "indexer-v2", "cranker"]);
    const plan = planGating({ services: RELAY_EXEMPT.join(","), dev: false });
    assert.equal(plan.refused.length, 0);
    for (const d of plan.decisions) {
      assert.equal(d.requireRelay, false);
      assert.equal(d.action, "allow");
    }
  });
  test("MONITOR_HEALTH lists selected ∪ existing services that expose a health URL", () => {
    const h = monitorHealth(["pricing", "cranker", "monitor"]);
    assert.match(h, /pricing=/);
    assert.match(h, /cranker=/);
    assert.doesNotMatch(h, /mm-bot=/);
    assert.doesNotMatch(h, /notifier=/);
    assert.doesNotMatch(h, /pricer=/);
    assert.equal(h.includes("monitor="), false);
    const monitorOnly = planGating({ services: "monitor", existing: ["pricing", "relay"] });
    assert.equal(monitorOnly.refused.length, 0);
    assert.match(monitorOnly.monitorHealth, /pricing=/);
    assert.match(monitorOnly.monitorHealth, /relay=/);
    assert.doesNotMatch(monitorOnly.monitorHealth, /monitor=/);
  });
  test("empty MONITOR_HEALTH is refused when monitor is selected", () => {
    const empty = planGating({ services: "monitor" });
    assert.deepEqual(empty.refused, ["monitor"]);
    assert.equal(empty.monitorHealth, "");
    assert.match(empty.decisions[0].reason, /MONITOR_HEALTH empty/);
  });
  test("signing services are refused on stonkhouse-dev and allowed on prod", () => {
    assert.deepEqual(SIGNING, ["cranker", "pricer", "mm-bot"]);
    const dev = planGating({ services: "cranker,pricer,mm-bot,pricing", dev: true });
    assert.deepEqual(dev.refused, ["cranker", "pricer", "mm-bot"]);
    assert.equal(dev.decisions.find((d) => d.service === "pricing").action, "allow");
    const prod = planGating({ services: "cranker,pricer,mm-bot", dev: false });
    assert.equal(prod.refused.length, 0);
  });
  test("SIGNING matches the KEYVAR column of go-live-v2.sh TABLE", () => {
    const sh = fs.readFileSync(SH, "utf8");
    const m = sh.match(/\nTABLE="\n([\s\S]*?)"\n/);
    assert.ok(m, "TABLE= block");
    const fromTable = m[1].trim().split("\n").map((line) => line.trim().split(/\s+/)).filter((cols) => cols.length >= 10 && cols[9] !== "-").map((cols) => cols[0]);
    assert.deepEqual(fromTable, SIGNING);
  });
});

describe("go-live-v2.sh --plan-gating", () => {
  test("prints allow for exempt services without touching Railway", () => {
    const out = planSh(["--services", "pricing,notifier,indexer-v2,cranker"]);
    assert.match(out, /"action": "allow"/);
    assert.doesNotMatch(out, /railway (up|link|whoami)/);
    assert.doesNotMatch(out, /callhouse-keys/);
    const json = JSON.parse(out.slice(out.indexOf("{")));
    assert.deepEqual(json.refused, []);
    assert.equal(json.decisions.every((d) => d.requireRelay === false), true);
  });
  test("refuses signing bots when the stonkhouse-dev project is selected", () => {
    const { code, stderr } = planShFail([
      "--project", DEV_PROJECT, "--environment", DEV_ENV,
      "--services", "mm-bot,pricer",
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /stonkhouse-dev|REFUSED/);
    assert.match(stderr, /mm-bot|pricer/);
  });
  test("dev default services contain no signing bot and plan successfully", () => {
    const out = planSh(["--project", DEV_PROJECT, "--environment", DEV_ENV]);
    const json = JSON.parse(out.slice(out.indexOf("{")));
    assert.deepEqual(json.refused, []);
    for (const s of SIGNING) assert.equal(json.services.includes(s), false, s);
    assert.ok(json.services.includes("monitor"));
    assert.ok(json.services.includes("pricing"));
    assert.match(json.monitorHealth, /pricing=/);
  });
  test("monitor-only with no existing health URLs is refused", () => {
    const { code, stderr } = planShFail(["--services", "monitor"]);
    assert.equal(code, 1);
    assert.match(stderr, /REFUSED/);
    assert.match(stderr, /MONITOR_HEALTH|monitor/);
  });
  test("monitor-only keeps health URLs of existing services", () => {
    const out = planSh(["--services", "monitor"], { EXISTING_SERVICES: "pricing,cranker,relay" });
    const json = JSON.parse(out.slice(out.indexOf("{")));
    assert.deepEqual(json.refused, []);
    assert.match(json.monitorHealth, /pricing=/);
    assert.match(json.monitorHealth, /cranker=/);
    assert.match(json.monitorHealth, /relay=/);
  });
  test("shell apply-time relay loop and ORDER come from the gating helper", () => {
    const sh = fs.readFileSync(SH, "utf8");
    assert.match(sh, /for alert_svc in \$RELAY_REQUIRED_FOR/);
    assert.doesNotMatch(sh, /for alert_svc in pricer mm-bot monitor/);
    assert.doesNotMatch(sh, /MONITOR_HEALTH='cranker=/);
    const printed = execFileSync("node", [path.join(OPS, "v2/go-live-gating.mjs"), "--print-order"], { encoding: "utf8" }).trim();
    assert.equal(printed, ORDER.join(" "));
  });
  test("--plan-gating is refused with --apply", () => {
    let code = 0;
    try {
      execFileSync("bash", [SH, "--plan-gating", "--apply", "--ref", "0123456789abcdef0123456789abcdef01234567", "--services", "pricing"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      code = e.status;
    }
    assert.equal(code, 1);
  });
  test("--help lists --plan-gating", () => {
    const out = execFileSync("bash", [SH, "--help"], { encoding: "utf8" });
    assert.match(out, /--plan-gating/);
  });
});

/**
 * O3-401. `notifier/src/config.ts` refuses to start when EMAIL_FROM or NOTIFIER_PUBLIC_URL is set
 * while SMTP_URL is not ("set all three or none"), and the dev path never sets SMTP_URL. Setting
 * NOTIFIER_PUBLIC_URL on every dev notifier deploy therefore crash-looped the service on a config
 * error naming a variable nobody had touched.
 *
 * These read the script rather than running it: the assignment happens inside an --apply run, which
 * needs Railway. Each one names the exact shape that broke, so restoring it fails here.
 */
describe("O3-401 NOTIFIER_PUBLIC_URL on the dev path", () => {
  const sh = fs.readFileSync(SH, "utf8");

  /** One shell function's body, from its `name() {` to the closing brace on its own line. */
  function functionBody(name) {
    const start = sh.indexOf(`\n${name}() {`);
    assert.ok(start > 0, `${name}() is not defined in go-live-v2.sh`);
    const end = sh.indexOf("\n}\n", start);
    assert.ok(end > start, `${name}() has no closing brace on its own line`);
    return sh.slice(start, end);
  }

  test("the unconditional dev assignment is gone, and there is exactly one assignment left", () => {
    assert.doesNotMatch(
      sh,
      /\[ "\$svc" = notifier \][^\n]*&&[^\n]*SETS\+=\("NOTIFIER_PUBLIC_URL/,
      "the dev path sets NOTIFIER_PUBLIC_URL unconditionally again: the dev notifier refuses to boot without SMTP_URL",
    );
    const assignments = sh.match(/SETS\+=\("NOTIFIER_PUBLIC_URL=/g) ?? [];
    assert.equal(assignments.length, 1, `NOTIFIER_PUBLIC_URL is added to SETS in ${assignments.length} places; only the SMTP_URL-guarded one may exist`);
  });

  test("the assignment sits behind an SMTP_URL check, with a branch that says why it was skipped", () => {
    const body = functionBody("set_variables");
    const guard = body.indexOf("var_is_set notifier SMTP_URL");
    const assign = body.indexOf('SETS+=("NOTIFIER_PUBLIC_URL=');
    assert.ok(guard > 0, "set_variables no longer asks whether SMTP_URL is set");
    assert.ok(assign > guard, "NOTIFIER_PUBLIC_URL is assigned before (or without) the SMTP_URL check");
    const between = body.slice(guard, assign);
    assert.doesNotMatch(between, /\belse\b|\bfi\b/, "the assignment is not in the branch the SMTP_URL check guards");
    assert.match(body, /NOTIFIER_PUBLIC_URL not set/, "nothing tells the operator why it was skipped");
    assert.match(body, /O3-401/);
  });

  test("a Railway read that fails counts as 'SMTP_URL not set', never as a die", () => {
    const body = functionBody("var_is_set");
    assert.match(body, /var_names "\$1"\) \|\| return 1/, "var_is_set dies (or ignores) instead of answering 'not set' when Railway cannot be read");
    assert.doesNotMatch(body, /\bdie\b/);
    assert.match(body, /grep -qx "\$2"/);
  });

  test("the dry run says the assignment is conditional instead of printing it", () => {
    const body = functionBody("set_variables");
    assert.match(body, /NOTIFIER_URL_NOTE="# NOTIFIER_PUBLIC_URL=/, "the dry run no longer explains the condition");
    assert.match(body, /only when SMTP_URL is already set/);
    // The note is per service: it must be cleared on entry, or notifier's note leaks onto monitor's plan.
    assert.match(body, /^\s*NOTIFIER_URL_NOTE=""$/m);
  });

  test("the dev notifier step does not promise NOTIFIER_PUBLIC_URL, and the runbook explains it", () => {
    const devNote = sh.match(/if \[ "\$DEV" = 1 \]; then note "# SMTP_URL[^\n]*/);
    assert.ok(devNote, "the notifier step's dev note is gone");
    assert.doesNotMatch(devNote[0], /\(\+ EMAIL_FROM, NOTIFIER_PUBLIC_URL\)/, "the dev note claims NOTIFIER_PUBLIC_URL is left alone like the prod one; on dev it is set only with SMTP_URL");
    assert.match(devNote[0], /O3-401/);
    const runbook = fs.readFileSync(path.join(OPS, "runbooks", "v2-dev-deploy.md"), "utf8");
    assert.match(runbook, /NOTIFIER_PUBLIC_URL/);
    assert.match(runbook, /set all three or none/);
    assert.match(runbook, /O3-401/);
  });
});

/**
 * O8-05. Four remaining pre-launch blockers. These pin the shape that would restore each one.
 * They do not talk to Railway or read keys.
 */
describe("O8-05 pre-launch services", () => {
  const ROOT = path.join(OPS, "..");
  const sh = fs.readFileSync(SH, "utf8");
  const dockerignore = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8");

  test("root .dockerignore re-includes ops/markets/dev.json as an exact line", () => {
    const lines = dockerignore.split("\n");
    assert.ok(lines.includes("!ops/markets/tier1.json"), "tier1.json exception is gone");
    assert.ok(
      lines.includes("!ops/markets/dev.json"),
      "dev.json is still excluded: a dev deploy of pricing or monitor is refused (GO-LIVE-V7-SERVICES §4 row 20)",
    );
    assert.match(sh, /grep -Fqx "!ops\/markets\/\$\(basename "\$REGISTRY"\)"/);
  });

  test("prod DEFAULT_SERVICES is the keyless set: no cranker, no pricer", () => {
    const m = sh.match(/^DEFAULT_SERVICES="([^"]+)"/m);
    assert.ok(m, "prod DEFAULT_SERVICES assignment is gone");
    const services = m[1].split(/\s+/);
    assert.deepEqual(services, ["relay", "indexer-v2", "pricing", "notifier", "monitor"]);
    for (const s of SIGNING) {
      assert.equal(services.includes(s), false, `prod default still includes signing bot ${s}`);
    }
  });

  test("a bare --plan-gating on prod no longer plans cranker or pricer", () => {
    const out = planSh([]);
    const json = JSON.parse(out.slice(out.indexOf("{")));
    assert.deepEqual(json.refused, []);
    for (const s of SIGNING) assert.equal(json.services.includes(s), false, s);
    for (const s of ["relay", "indexer-v2", "pricing", "notifier", "monitor"]) {
      assert.ok(json.services.includes(s), s);
    }
  });

  test("--apply compares selected-service env assignments, not the whole env directory", () => {
    assert.doesNotMatch(sh, /diff -qr "\$ENV_DIR"/, "whole-dir env equality is back: a pricer.env comment refuses a production monitor");
    assert.match(sh, /env-equal\.mjs/);
    assert.match(sh, /--services "\$\(printf '%s' "\$SERVICES" \| tr ' ' ','\)"/);
  });

  test("v2-env.mjs never emits a live NOTIFIER_PUBLIC_URL or EMAIL_FROM assignment", () => {
    const renderer = fs.readFileSync(path.join(OPS, "v2-env.mjs"), "utf8");
    assert.match(renderer, /NOTIFIER_PUBLIC_URL and EMAIL_FROM must stay comments/);
    for (const rel of ["v2/env/notifier.env", "v2/env-dev/notifier.env"]) {
      const env = fs.readFileSync(path.join(OPS, rel), "utf8");
      assert.doesNotMatch(
        env,
        /^NOTIFIER_PUBLIC_URL=/m,
        `${rel} assigns NOTIFIER_PUBLIC_URL: the notifier refuses to boot without SMTP_URL`,
      );
      assert.doesNotMatch(env, /^EMAIL_FROM=/m, `${rel} assigns EMAIL_FROM`);
      assert.match(env, /^# NOTIFIER_PUBLIC_URL=/m);
    }
  });

  test("ops-only publication packet exists and names remaining owner inputs without values", () => {
    const packet = fs.readFileSync(path.join(OPS, "runbooks", "ops-only-publication.md"), "utf8");
    assert.match(packet, /O8-05/);
    assert.match(packet, /O3-401/);
    assert.match(packet, /O3-004/);
    assert.match(packet, /O3-006/);
    for (const name of [
      "RELAY_TOKEN",
      "DISCORD_WEBHOOK_URL",
      "NOTIFIER_DATA_KEY",
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
    ]) {
      assert.match(packet, new RegExp(`\\b${name}\\b`));
    }
    assert.doesNotMatch(packet, /-----BEGIN/);
    assert.doesNotMatch(packet, /xoxb-/);
    assert.doesNotMatch(packet, /discord\.com\/api\/webhooks\/\d+\//);
  });
});
