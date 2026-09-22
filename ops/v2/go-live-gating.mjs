#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * O3-004: single owner of go-live-v2.sh service-gating.
 *
 *   RELAY_REQUIRED  pricer, mm-bot, monitor
 *   RELAY_EXEMPT    pricing, notifier, indexer-v2, cranker
 *   SIGNING         cranker, pricer, mm-bot  — refused when the stonkhouse-dev project is selected
 *   MONITOR_HEALTH  selected ∪ existing services that expose a health URL; empty is refused when
 *                   monitor is selected (never a silent skip)
 *
 *   SERVICES="pricing cranker" DEV=0 node ops/v2/go-live-gating.mjs
 *   node ops/v2/go-live-gating.mjs --services pricer,mm-bot --dev
 *   node ops/v2/go-live-gating.mjs --services monitor --existing pricing,cranker
 *   node ops/v2/go-live-gating.mjs --print-order
 * ------------------------------------------------------------------------------------------------- */
export const RELAY_REQUIRED = ["pricer", "mm-bot", "monitor"];
export const RELAY_EXEMPT = ["pricing", "notifier", "indexer-v2", "cranker"];
export const SIGNING = ["cranker", "pricer", "mm-bot"];
export const ORDER = ["relay", "indexer-v2", "pricing", "cranker", "pricer", "mm-bot", "notifier", "monitor", "web"];

export const HEALTH_URL = {
  relay: "http://relay.railway.internal:8080/health",
  "indexer-v2": "http://indexer-v2.railway.internal:42069/v2/health",
  pricing: "http://pricing.railway.internal:8790/health",
  cranker: "http://cranker.railway.internal:8792/health",
  pricer: "http://pricer.railway.internal:8794/health",
  "mm-bot": "http://mm-bot.railway.internal:8793/health",
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

export function monitorHealth(services) {
  return services.filter((s) => HEALTH_URL[s]).map((s) => `${s}=${HEALTH_URL[s]}`).join(",");
}

export function planGating({ services, dev = false, existing = [] } = {}) {
  const selected = parseServices(services);
  const existingKnown = knownServices(existing);
  const healthFrom = ORDER.filter((s) => (selected.includes(s) || existingKnown.includes(s)) && HEALTH_URL[s]);
  const health = monitorHealth(healthFrom);
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
  const plan = planGating({ services, existing, dev });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
