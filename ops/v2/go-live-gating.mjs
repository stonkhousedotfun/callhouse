#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * Single owner of go-live-v2.sh service-gating.
 *
 *   RELAY_REQUIRED  pricer, mm-bot, guardian, monitor
 *   RELAY_EXEMPT    pricing, notifier, indexer-v2, cranker
 *   SIGNING         cranker, pricer, mm-bot, guardian  — refused when the stonkhouse-dev project is selected
 *
 *   guardian is the keeper image with V2_MODE=guardian: it vetoes a bad settlement price
 *   before it becomes final. It signs (GUARDIAN_PK), and without the relay it vetoes and tells nobody, so it is
 *   both SIGNING and RELAY_REQUIRED. It is never in go-live-v2.sh's DEFAULT_SERVICES: name it explicitly.
 *   MONITOR_HEALTH  selected ∪ existing services that expose a health URL; empty is refused when
 *                   monitor is selected (never a silent skip). indexer-v2 adds its
 *                   /v2/health/house-registry as the target indexer-v2-house-registry (EXTRA_HEALTH_URL)
 *   MONITOR_PRICING_URL, MONITOR_PRICER_URL  the pricing service's and the pricer's base URLs, when they
 *                   are selected or exist. Without them the monitor's `pricing` check reports itself skipped on every
 *                   pass (monitor.mjs "no --pricing / --pricer target"), and a skipped check counts as completed.
 *   launchNotRunning  the ORDER services neither selected nor already deployed. Every one of them is part of the
 *                   v9 launch, and DEFAULT_SERVICES in go-live-v2.sh deliberately leaves the signing bots out, so a
 *                   go-live that names fewer says which are still not running instead of finishing quietly.
 *   MONITOR_HOUSE_VAULTS  TICKER=0xaddress for every House vault the registry records (markets[].v2.house
 *                   daily/weekly, written back by the launch's window step). Without it the monitor's `house`
 *                   check (the boundary epoch stall and the unpinned boundary) is skipped on every pass.
 *   MONITOR_THRESHOLDS  the audit trigger, the exact line ops/v8/tvl-threshold.mjs derives from the
 *                   registry (thresholdEnvLine). Without it auditTriggerUsdg stays 0 and the launch's first deposit pages
 *                   v2_mon_tvl_audit_trigger at error (the trigger off while funded, by design).
 *
 *   SERVICES="pricing cranker" DEV=0 node ops/v2/go-live-gating.mjs
 *   node ops/v2/go-live-gating.mjs --services pricer,mm-bot --dev
 *   node ops/v2/go-live-gating.mjs --services monitor --existing pricing,cranker
 *   node ops/v2/go-live-gating.mjs --services monitor --existing pricing --registry ops/markets/tier1.json
 *   node ops/v2/go-live-gating.mjs --print-order
 *
 *   healthServices, baseUrls  every ORDER service with a HEALTH_URL (independent of the selection), and each
 *                   selected-or-existing one's internal base URL. stonkctl prelaunch-gate reads both.
 * ------------------------------------------------------------------------------------------------- */
import { readFileSync } from "node:fs";

import { TvlThresholdError, deriveTrigger, thresholdEnvLine } from "../v8/tvl-threshold.mjs";

export const RELAY_REQUIRED = ["pricer", "mm-bot", "guardian", "monitor"];
export const RELAY_EXEMPT = ["pricing", "notifier", "indexer-v2", "cranker"];
export const SIGNING = ["cranker", "pricer", "mm-bot", "guardian"];
export const ORDER = ["relay", "indexer-v2", "pricing", "cranker", "pricer", "mm-bot", "guardian", "notifier", "monitor", "web"];

export const HEALTH_URL = {
  relay: "http://relay.railway.internal:8080/health",
  "indexer-v2": "http://indexer-v2.railway.internal:42069/v2/health",
  pricing: "http://pricing.railway.internal:8790/health",
  cranker: "http://cranker.railway.internal:8792/health",
  pricer: "http://pricer.railway.internal:8794/health",
  "mm-bot": "http://mm-bot.railway.internal:8793/health",
  // keeper/src/v2/config.ts DEFAULT_MODE_PORT.guardian (go-live-v2.test.mjs reads the port from there).
  guardian: "http://guardian.railway.internal:8795/health",
  notifier: "http://notifier.railway.internal:8791/health",
};

function splitNames(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  return String(raw ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

export function parseServices(raw) {
  const parts = splitNames(raw);
  const unknown = parts.filter((s) => !ORDER.includes(s));
  if (unknown.length) throw new Error(`unknown service '${unknown[0]}'`);
  return ORDER.filter((s) => parts.includes(s));
}

/** Ignore names that are not go-live services (Railway extras such as Postgres). */
export function knownServices(raw) {
  const parts = new Set(splitNames(raw));
  return ORDER.filter((s) => parts.has(s));
}

/**
 * Targets a service serves beside its /health, each probed by the monitor's `health` check under its own name.
 * indexer-v2's /v2/health/house-registry answers 503 when a House vault the factory created is not indexed
 * (HOUSE_VAULT_UNREGISTERED) or, with V2_PRODUCTION=1, when its House source is not the registry's
 * (HOUSE_FACTORY_NOT_REGISTRY, HOUSE_SOURCE_FACTORY_FALLBACK); it deserves an uptime check. The
 * indexer's own /v2/health stays 200 through all three, so without this entry nothing watched them.
 */
export const EXTRA_HEALTH_URL = {
  "indexer-v2": { "indexer-v2-house-registry": "http://indexer-v2.railway.internal:42069/v2/health/house-registry" },
};

export function monitorHealth(services) {
  return services
    .filter((s) => HEALTH_URL[s])
    .flatMap((s) => [[s, HEALTH_URL[s]], ...Object.entries(EXTRA_HEALTH_URL[s] ?? {})])
    .map(([name, url]) => `${name}=${url}`)
    .join(",");
}

/** A service's base URL for the monitor's --pricing / --pricer (it appends /health, /fair, /surface, /state itself). */
export const baseOf = (service) => new URL(HEALTH_URL[service]).origin;

/**
 * The House vaults the registry records, as MONITOR_HOUSE_VAULTS: `TICKER=0xaddress` for each market row's
 * `v2.house.daily` / `v2.house.weekly` (and the legacy single `v2.houseVault`), each address once. The monitor's
 * `house` check reads nothing without it; its "the registry cannot name factory-created vaults" was true before the
 * launch's window step started writing each vault back into its market row.
 */
export function monitorHouseVaults(registry) {
  const out = [];
  const seen = new Set();
  for (const m of registry?.markets ?? []) {
    const v2 = m?.v2 ?? {};
    for (const address of [v2.house?.daily, v2.house?.weekly, v2.houseVault]) {
      if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || seen.has(address.toLowerCase())) continue;
      seen.add(address.toLowerCase());
      out.push(`${m.ticker}=${address}`);
    }
  }
  return out.join(",");
}

/**
 * The monitor's MONITOR_THRESHOLDS line: ops/v8/tvl-threshold.mjs's thresholdEnvLine over its deriveTrigger,
 * so the audit trigger comes from one place and is never typed here. A v9 fork showed the gap: go-live set
 * no MONITOR_THRESHOLDS, auditTriggerUsdg stayed 0, and the first 1,000 USDG MakerVault deposit paged
 * v2_mon_tvl_audit_trigger at error. `why` says what is wrong when the registry cannot express the trigger (the tool
 * refuses rather than emit a 0) or names fewer holders than the trigger counts (the line is kept; it pages late).
 */
export function monitorThresholds(registry) {
  try {
    const t = deriveTrigger(registry);
    const why = t.missingHolders.length === 0 ? "" : `the registry names no ${t.missingHolders.join(", ")}, so the audit trigger sums ${t.holders.length} of its holders and pages late`;
    return { line: thresholdEnvLine(t), why };
  } catch (error) {
    if (error instanceof TvlThresholdError) return { line: "", why: error.message };
    throw error;
  }
}

export function planGating({ services, dev = false, existing = [], registry = null } = {}) {
  const selected = parseServices(services);
  const existingKnown = knownServices(existing);
  const healthFrom = ORDER.filter((s) => (selected.includes(s) || existingKnown.includes(s)) && HEALTH_URL[s]);
  const health = monitorHealth(healthFrom);
  const thresholds = registry === null ? { line: "", why: "no --registry given" } : monitorThresholds(registry);
  const reachable = (s) => selected.includes(s) || existingKnown.includes(s);
  const decisions = selected.map((service) => {
    const requireRelay = RELAY_REQUIRED.includes(service);
    const signing = SIGNING.includes(service);
    const refuseDev = Boolean(dev) && signing;
    let action = "allow";
    let reason = requireRelay ? "relay-required" : RELAY_EXEMPT.includes(service) ? "relay-exempt" : "no-relay-rule";
    if (refuseDev) {
      action = "refuse";
      reason = "signing service refused when project stonkhouse-dev is selected";
    }
    if (service === "monitor" && !health) {
      action = "refuse";
      reason = "MONITOR_HEALTH empty: no selected or existing service exposes a health URL";
    }
    return { service, requireRelay, signing, allowedOnDev: !signing, action, reason };
  });
  return {
    services: selected,
    existing: existingKnown,
    dev: Boolean(dev),
    decisions,
    relayRequiredFor: RELAY_REQUIRED,
    relayExempt: RELAY_EXEMPT,
    signing: SIGNING,
    order: ORDER,
    monitorHealth: health,
    monitorPricingUrl: reachable("pricing") ? baseOf("pricing") : "",
    monitorPricerUrl: reachable("pricer") ? baseOf("pricer") : "",
    monitorHouseVaults: registry === null ? "" : monitorHouseVaults(registry),
    // The whole `MONITOR_THRESHOLDS=...` line, from ops/v8/tvl-threshold.mjs; empty when it cannot be derived.
    monitorThresholds: thresholds.line,
    monitorThresholdsWhy: thresholds.why,
    // Every service is part of the v9 launch; the ones neither selected nor already deployed are not running.
    launchNotRunning: ORDER.filter((s) => !reachable(s)),
    // Every ORDER service with a /health URL, whatever was selected: the set a full MONITOR_HEALTH names, which
    // stonkctl prelaunch-gate holds its health list to. And the internal base URL of each one in monitorHealth, which it
    // hands the pre-launch gate (relay, pricing, indexer-v2, notifier).
    healthServices: ORDER.filter((s) => HEALTH_URL[s]),
    baseUrls: Object.fromEntries(healthFrom.map((s) => [s, baseOf(s)])),
    refused: decisions.filter((d) => d.action === "refuse").map((d) => d.service),
  };
}

const isMain = process.argv[1] && String(process.argv[1]).endsWith("go-live-gating.mjs");
if (isMain) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
  };
  if (process.argv.includes("--print-order")) {
    process.stdout.write(`${ORDER.join(" ")}\n`);
    process.exit(0);
  }
  const services = arg("--services") ?? process.env.SERVICES ?? "";
  const existing = arg("--existing") ?? process.env.EXISTING ?? "";
  const dev = process.argv.includes("--dev") || process.env.DEV === "1";
  const registryPath = arg("--registry");
  const registry = registryPath ? JSON.parse(readFileSync(registryPath, "utf8")) : null;
  const plan = planGating({ services, existing, dev, registry });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
