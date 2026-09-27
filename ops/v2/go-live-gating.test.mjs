/**
 * node --test ops/v2/go-live-gating.test.mjs
 *
 * The two fields stonkctl prelaunch-gate reads from planGating (healthServices, baseUrls), through the same
 * command line it runs. The rest of go-live-gating.mjs is covered by ops/go-live-v2.test.mjs.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { HEALTH_URL, ORDER, planGating } from "./go-live-gating.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const names = (health) => health.split(",").filter(Boolean).map((p) => p.slice(0, p.indexOf("=")));

describe("healthServices and baseUrls", () => {
  test("healthServices is every ORDER service with a HEALTH_URL, whatever was selected", () => {
    const want = ORDER.filter((s) => HEALTH_URL[s]);
    assert.ok(want.length >= 8 && !want.includes("monitor") && !want.includes("web"), want.join(","));
    for (const services of [ORDER.join(","), "relay,indexer-v2,pricing,notifier,monitor", "monitor"]) {
      assert.deepEqual(planGating({ services, existing: services === "monitor" ? ["relay"] : [] }).healthServices, want, services);
    }
  });

  test("a full selection's MONITOR_HEALTH names every healthServices entry; go-live's default set does not", () => {
    const full = planGating({ services: ORDER.join(",") });
    assert.deepEqual(full.healthServices.filter((s) => !names(full.monitorHealth).includes(s)), []);
    const dflt = planGating({ services: "relay,indexer-v2,pricing,notifier,monitor" });
    assert.deepEqual(dflt.healthServices.filter((s) => !names(dflt.monitorHealth).includes(s)), ["cranker", "pricer", "mm-bot", "guardian"]);
  });

  test("baseUrls is each reachable health service's internal origin, and only those", () => {
    const full = planGating({ services: ORDER.join(",") });
    assert.deepEqual(Object.keys(full.baseUrls), full.healthServices);
    for (const [s, url] of Object.entries(full.baseUrls)) assert.equal(url, new URL(HEALTH_URL[s]).origin, s);
    assert.equal(full.baseUrls.relay, "http://relay.railway.internal:8080");
    assert.equal(full.baseUrls.pricing, full.monitorPricingUrl);
    const some = planGating({ services: "monitor", existing: ["relay", "Postgres"] });
    assert.deepEqual(some.baseUrls, { relay: "http://relay.railway.internal:8080" });
  });

  test("the command stonkctl runs prints both, with the registry's House vaults", () => {
    const out = JSON.parse(execFileSync("node", [path.join(HERE, "go-live-gating.mjs"), "--services", ORDER.join(","),
      "--registry", path.join(ROOT, "ops", "markets", "tier1.json")], { encoding: "utf8" }));
    assert.deepEqual(out.healthServices, ORDER.filter((s) => HEALTH_URL[s]));
    assert.deepEqual(Object.keys(out.baseUrls), out.healthServices);
    assert.deepEqual(out.refused, []);
    assert.deepEqual(out.launchNotRunning, []);
  });
});
