import { Hono } from "hono";

import { V2_CLEARINGHOUSE } from "../../../lib/env";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { cache15s } from "../cache";
import { registerMachineRoutes, indexedHead } from "./machine";
import { registerMarketRoutes } from "./markets";
import { registerAccountRoutes } from "./accounts";
import { registerAdminRoutes } from "./admin";
import { registerFeedRoutes } from "./feed";
import { registerFlywheelRoutes } from "./flywheel";
import { registerEarnRoutes } from "./earn";
import { registerHouseRoutes } from "./house";
import { registerRewardRoutes } from "./rewards";
import { registerServiceRoutes } from "./services";
import { registerVaultRoutes } from "./vault";
import { ROUTES } from "./schema";

export const v2App = new Hono();

v2App.use("*", async (c, next) => {
  if (V2_CLEARINGHOUSE === undefined) {
    return c.json({ error: { code: "not_configured", message: "V2_CLEARINGHOUSE is not configured." } }, 404);
  }
  await next();
});

// /v2/services joins the no-cache list for the reason the route exists: a 15s edge copy would go
// on reporting a dead pricer as healthy for 15 seconds after it died. services.ts holds its own
// short cache, which it can invalidate; the edge cannot.
v2App.use("*", async (c, next) => c.req.path === "/v2/health" || c.req.path === "/v2/config" || c.req.path === "/v2/services"
  ? next() : cache15s(c, next));

/** Keep the producer on the exact strict schema copied from the web consumer. */
v2App.use("*", async (c, next) => {
  await next();
  if (c.res.status < 200 || c.res.status >= 300 || c.req.method !== "GET") return;
  const route = ROUTES.find((candidate) => {
    const pattern = candidate.route.replace(/:[^/]+/g, "[^/]+");
    return new RegExp(`^${pattern}$`).test(c.req.path);
  });
  if (!route) return;
  try {
    const body = await c.res.clone().json();
    const parsed = route.schema.safeParse(body);
    if (!parsed.success) {
      console.error("v2 API response does not match frozen schema", c.req.path, parsed.error.flatten());
      c.res = c.json({ error: { code: "schema_mismatch", message: "The indexer returned an invalid v2 response." } }, 500);
    }
  } catch {
    c.res = c.json({ error: { code: "schema_mismatch", message: "The indexer returned invalid JSON." } }, 500);
  }
});

v2App.get("/health", async (c) => {
  c.header("cache-control", "no-store");
  const head = await indexedHead();
  const lag = head === null ? null : Math.max(0, Math.floor(Date.now() / 1000) - Number(head.ts));
  const status = lag === null ? "degraded" : lag <= 120 ? "ok" : "lagging";
  return c.json({ status, block: (head?.block ?? 0n).toString(), lagSeconds: lag ?? 0, interfaceVersion: V2_REGISTRY.interfaceVersion },
    status === "degraded" ? 503 : 200);
});

registerMarketRoutes(v2App);
registerMachineRoutes(v2App);
registerAccountRoutes(v2App);
registerFeedRoutes(v2App);
registerAdminRoutes(v2App);
registerFlywheelRoutes(v2App);
registerEarnRoutes(v2App);
registerHouseRoutes(v2App);
registerRewardRoutes(v2App);
registerVaultRoutes(v2App);
registerServiceRoutes(v2App);
