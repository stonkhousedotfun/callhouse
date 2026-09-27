import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";

import { V2_CLEARINGHOUSE, V2_HOUSE_START_BLOCK, V2_HOUSE_VAULT_FACTORY, V2_PRODUCTION } from "../../../lib/env";
import { houseRegistryHealth, v2HouseVaultSource, v2LaunchFactoryMismatch } from "../../../lib/v2/houseVaultSource";
import { registryHealth, v2RegistryClearinghouseCheck } from "../../v2/registryClearinghouse";

/**
 * /v2/health/house-registry: does the HouseVault source's address list cover every vault the factory made?
 *
 * The HouseVault source is the registry's vault list (lib/v2/houseVaultSource.ts), so a vault the factory creates
 * before the registry names it has its VaultCreated indexed but none of its own events. This route is the flag for
 * that: 503 with `alert: "HOUSE_VAULT_UNREGISTERED"` and the vaults named, 200 otherwise. It also says which mode the
 * source is in, because the factory() fallback is correct for a dev deployment and a cost regression in production.
 *
 * In a V2_PRODUCTION=1 process (lib/env.ts) the fallback is a 503 too: `HOUSE_FACTORY_NOT_REGISTRY` when
 * V2_HOUSE_VAULT_FACTORY is not the registry's v2.contracts.houseVaultFactory (boot normally refuses that first), and
 * `HOUSE_SOURCE_FACTORY_FALLBACK` for any other factory() mode. A production image built before the registry regen
 * used to answer 200 `ok: true` here while its House source discovered zero vaults. Dev, rehearsal and fork processes
 * leave V2_PRODUCTION unset and keep the 200 with `mode: "factory"` and the reason.
 *
 * A separate route, not a field on /v2/health: that response is a strict schema shared byte-for-byte with the web
 * (web/lib/v2/api-schema.ts), and the web boots on it. This one has no consumer but an uptime check, so it is not in
 * ROUTES and is not cached (src/api/v2/index.ts).
 */
export function registerHealthRoutes(app: Hono) {
  app.get("/health/house-registry", async (c) => {
    c.header("cache-control", "no-store");
    if (V2_HOUSE_VAULT_FACTORY === undefined || V2_HOUSE_START_BLOCK === undefined) {
      return c.json({ ok: true, configured: false }, 200);
    }
    const source = v2HouseVaultSource(V2_HOUSE_VAULT_FACTORY, V2_HOUSE_START_BLOCK);
    const rows = await db.select({
      vault: schema.v2HouseVault.vault,
      factory: schema.v2HouseVault.factory,
      createdBlock: schema.v2HouseVault.createdBlock,
    }).from(schema.v2HouseVault);
    const body = houseRegistryHealth(source, rows, {
      production: V2_PRODUCTION,
      launchMismatch: v2LaunchFactoryMismatch(V2_HOUSE_VAULT_FACTORY),
    });
    return c.json({ ...body, configured: true }, body.ok ? 200 : 503);
  });

  /**
   * /v2/health/registry: is env's V2_CLEARINGHOUSE the baked registry's? When it is not, the House factory
   * source and the price sources drop themselves (src/v2/registryClearinghouse.ts). A V2_PRODUCTION=1 process refuses
   * boot on that (ponder.config.ts), so this route is for the processes that keep running: dev, rehearsal and fork
   * answer 200 with `mismatch` and `silenced` naming what is not indexed, and a production process that somehow
   * serves answers 503 `REGISTRY_CLEARINGHOUSE_MISMATCH`. A sub-route and not a field on /v2/health, for the reason
   * above: that response is the strict schema the web boots on.
   */
  app.get("/health/registry", (c) => {
    c.header("cache-control", "no-store");
    const body = registryHealth(v2RegistryClearinghouseCheck(V2_CLEARINGHOUSE), V2_PRODUCTION);
    return c.json(body, body.ok ? 200 : 503);
  });
}
