import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { getAddress, type Address } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "../../../ponder.schema";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import {
  HOUSE_FACTORY_NOT_REGISTRY,
  HOUSE_VAULT_UNREGISTERED,
  type HouseRegistryShape,
} from "../../../lib/v2/houseVaultSource";
import { REGISTRY_CLEARINGHOUSE_MISMATCH } from "../../v2/registryClearinghouse";

/**
 * /v2/health/house-registry through the exported v2 app, mounted at /v2 exactly as src/api/index.ts
 * mounts it. The route's logic has unit cases in src/v2/config.test.ts; those call houseRegistryHealth directly and
 * cannot see whether index.ts registers the route, whether it is on the NO_CACHE list, or what status it answers.
 * These can: delete `registerHealthRoutes(v2App)` from index.ts and every case here is a 404.
 *
 * lib/env reads V2_HOUSE_VAULT_FACTORY, V2_HOUSE_START_BLOCK, V2_PRODUCTION and V2_CLEARINGHOUSE once at import, so
 * the four are mocked as getters over `state` and each case sets the deployment it needs. Everything else in lib/env is
 * the real module.
 */

const state = vi.hoisted(() => {
  process.env.PONDER_RPC_URL_4663 ??= "http://127.0.0.1:1";
  process.env.VAULT_ADDRESS ??= "0x000000000000000000000000000000000000c0de";
  process.env.USDG ??= "0x0000000000000000000000000000000000000001";
  process.env.START_BLOCK ??= "1";
  process.env.V2_CLEARINGHOUSE ??= "0x000000000000000000000000000000000000c011";
  process.env.V2_ORDER_BOOK ??= "0x000000000000000000000000000000000000c012";
  process.env.V2_SETTLEMENT_ORACLE ??= "0x000000000000000000000000000000000000c013";
  process.env.V2_AUTO_ROLLER ??= "0x000000000000000000000000000000000000c014";
  process.env.V2_MAKER_REGISTRY ??= "0x000000000000000000000000000000000000c015";
  process.env.V2_ACCESS_MANAGER ??= "0x0000000000000000000000000000000000006016";
  process.env.V2_FEE_SPLITTER ??= "0x0000000000000000000000000000000000007001";
  process.env.V2_BUYBACK_EXECUTOR ??= "0x0000000000000000000000000000000000007002";
  process.env.V2_FLYWHEEL_TOKEN_ADDRESS ??= "0x0000000000000000000000000000000000007003";
  process.env.V2_REWARDS_DISTRIBUTORS ??= JSON.stringify([
    { program: "maker", address: "0x0000000000000000000000000000000000005015" },
  ]);
  process.env.V2_MAKER_VAULT ??= "0x0000000000000000000000000000000000005016";
  process.env.V2_EARN_VAULT ??= "0x000000000000000000000000000000000000e011";
  process.env.V2_EARN_START_BLOCK ??= "50";
  process.env.V2_FLYWHEEL_START_BLOCK ??= "50";
  process.env.V2_START_BLOCK ??= "100";
  process.env.PRICING_URL ??= "http://127.0.0.1:8790";
  return {
    db: null as unknown,
    houseFactory: undefined as `0x${string}` | undefined,
    houseStartBlock: undefined as number | undefined,
    production: false,
    clearinghouse: process.env.V2_CLEARINGHOUSE as `0x${string}` | undefined,
  };
});

vi.mock("ponder:api", () => ({ get db() { return state.db; }, publicClients: {} }));
vi.mock("ponder:schema", () => ({ ...schema, default: schema }));
vi.mock("../../../lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/env")>()),
  get V2_HOUSE_VAULT_FACTORY() { return state.houseFactory; },
  get V2_HOUSE_START_BLOCK() { return state.houseStartBlock; },
  get V2_PRODUCTION() { return state.production; },
  get V2_CLEARINGHOUSE() { return state.clearinghouse; },
}));

const ROUTE = "http://localhost/v2/health/house-registry";

// The deployment the generated registry describes: its launch House factory and the vaults it lists. Read from the
// registry rather than typed, so these cases exercise registry mode for whatever deployment is checked in.
const REGISTRY = V2_REGISTRY as unknown as HouseRegistryShape;
// The launch factory's own entry, found by v2.contracts.houseVaultFactory. It was the `weekly` entry on v8
// and is the `daily` one on v9, so a lookup by kind found nothing and this file failed to load.
const LAUNCH_ENTRY = REGISTRY.house!.factories.find((f) => f.address.toLowerCase() === REGISTRY.contracts.houseVaultFactory!.toLowerCase())!;
const REGISTRY_FACTORY = getAddress(LAUNCH_ENTRY.address);
const REGISTRY_START = LAUNCH_ENTRY.deployBlock!;
const REGISTRY_VAULTS: Address[] = REGISTRY.house!.vaults.map((v) => getAddress(v.address));
const UNREGISTERED_VAULT = "0x00000000000000000000000000000000000beef1" as const;
const OTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
// Not the registry's Clearinghouse: the dev/rehearsal/fork footing, and the stale-image case in production.
const OTHER_CLEARINGHOUSE = "0x000000000000000000000000000000000000c011" as const;
const REGISTRY_CLEARINGHOUSE = V2_REGISTRY.contracts.clearinghouse as `0x${string}`;

let pg: PGlite;
let app: Hono;
let database: ReturnType<typeof drizzle<typeof schema>>;

function vaultRow(vault: string, factory: string, createdBlock: bigint) {
  // Ponder stores hex columns lowercase; the route compares lowercase, so seed what the indexer writes.
  return {
    vault: vault.toLowerCase() as `0x${string}`, underlying: "0x0000000000000000000000000000000000000011" as const,
    sharesToken: vault.toLowerCase() as `0x${string}`, factory: factory.toLowerCase() as `0x${string}`,
    kind: "weekly", name: "House", symbol: "HOUSE", createdAt: 1n, createdBlock, createdLogIndex: 0,
    createdTx: `0x${"1".repeat(64)}` as `0x${string}`,
  };
}

async function get() {
  const response = await app.request(ROUTE);
  // An unmounted route is Hono's plain-text 404; keep it so the failure reads as the status, not a JSON parse error.
  const text = await response.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { text }; }
  return { status: response.status, cacheControl: response.headers.get("cache-control"), body };
}

beforeAll(async () => {
  expect(REGISTRY_VAULTS.length).toBeGreaterThan(0);
  pg = new PGlite();
  const config = getTableConfig(schema.v2HouseVault);
  const columns = config.columns.map((column) =>
    `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`);
  await pg.exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
  database = drizzle({ client: pg, schema });
  state.db = database;
  app = new Hono().route("/v2", (await import("./index")).v2App);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  // No clearCache on purpose: the route must never be served from cache15s, so a copy left by an earlier case
  // would itself be the regression these cases exist to catch.
  await database.delete(schema.v2HouseVault);
  state.houseFactory = undefined;
  state.houseStartBlock = undefined;
  state.production = false;
  state.clearinghouse = OTHER_CLEARINGHOUSE;
});

describe("/v2/health/house-registry through the exported v2 app", () => {
  it("is mounted and answers 200 configured:false when no House factory is configured", async () => {
    const { status, cacheControl, body } = await get();
    expect(status).toBe(200);
    expect(cacheControl).toBe("no-store");
    expect(body).toEqual({ ok: true, configured: false });
  });

  it("answers 200 in registry mode when every indexed vault is in the registry list", async () => {
    state.houseFactory = REGISTRY_FACTORY;
    state.houseStartBlock = REGISTRY_START;
    await database.insert(schema.v2HouseVault).values(
      REGISTRY_VAULTS.map((vault, i) => vaultRow(vault, REGISTRY_FACTORY, BigInt(REGISTRY_START + i))));

    const { status, cacheControl, body } = await get();
    expect(status).toBe(200);
    expect(cacheControl).toBe("no-store");
    expect(body).toEqual({
      ok: true, alert: null, message: null, production: false, mode: "registry", reason: null, configured: true,
      registered: [...REGISTRY_VAULTS].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)),
      indexed: REGISTRY_VAULTS.length, unregistered: [],
    });
  });

  it("answers 503 HOUSE_VAULT_UNREGISTERED naming a factory-made vault the registry does not list", async () => {
    state.houseFactory = REGISTRY_FACTORY;
    state.houseStartBlock = REGISTRY_START;
    await database.insert(schema.v2HouseVault).values([
      vaultRow(REGISTRY_VAULTS[0]!, REGISTRY_FACTORY, BigInt(REGISTRY_START)),
      vaultRow(UNREGISTERED_VAULT, REGISTRY_FACTORY, 123n),
    ]);

    const { status, cacheControl, body } = await get();
    expect(status).toBe(503);
    expect(cacheControl).toBe("no-store");
    expect(body).toMatchObject({ ok: false, alert: HOUSE_VAULT_UNREGISTERED, mode: "registry", configured: true,
      indexed: 2 });
    expect(body.unregistered).toEqual([
      { vault: UNREGISTERED_VAULT, factory: REGISTRY_FACTORY.toLowerCase(), createdBlock: "123" }]);
  });

  it("reports the factory() fallback with its reason and never flags under it", async () => {
    state.houseFactory = OTHER_FACTORY;
    state.houseStartBlock = 10;
    await database.insert(schema.v2HouseVault).values(vaultRow(UNREGISTERED_VAULT, OTHER_FACTORY, 11n));

    const { status, cacheControl, body } = await get();
    expect(status).toBe(200);
    expect(cacheControl).toBe("no-store");
    expect(body).toMatchObject({ ok: true, alert: null, production: false, mode: "factory", configured: true,
      registered: [], indexed: 1, unregistered: [] });
    expect(body.reason).toContain("is not a registry House factory");
  });

  // The measured case, through the route: a V2_PRODUCTION=1 process whose launch factory the baked registry
  // does not name (the v9 env on an image built before the registry regen). Boot refuses it first (ponder.config.ts);
  // this is the route's own answer if such a process ever serves. It used to be the 200 `ok: true` above.
  it("answers 503 HOUSE_FACTORY_NOT_REGISTRY for the same factory() fallback in a production process", async () => {
    state.houseFactory = OTHER_FACTORY;
    state.houseStartBlock = 10;
    state.production = true;

    const { status, cacheControl, body } = await get();
    expect(status).toBe(503);
    expect(cacheControl).toBe("no-store");
    expect(body).toMatchObject({ ok: false, alert: HOUSE_FACTORY_NOT_REGISTRY, production: true, mode: "factory",
      configured: true, indexed: 0, unregistered: [] });
    expect(body.message).toContain(
      `V2_HOUSE_VAULT_FACTORY ${OTHER_FACTORY} is not the baked registry's v2.contracts.houseVaultFactory`);
    expect(body.reason).toContain("is not a registry House factory");
  });

  it("answers 200 in registry mode for a production process on its own registry (the positive control)", async () => {
    state.houseFactory = REGISTRY_FACTORY;
    state.houseStartBlock = REGISTRY_START;
    state.production = true;
    await database.insert(schema.v2HouseVault).values(
      REGISTRY_VAULTS.map((vault, i) => vaultRow(vault, REGISTRY_FACTORY, BigInt(REGISTRY_START + i))));

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, alert: null, message: null, production: true, mode: "registry",
      indexed: REGISTRY_VAULTS.length, unregistered: [] });
  });

  it("is never served from the 15s cache: an alert raised after a healthy answer shows on the next request", async () => {
    state.houseFactory = REGISTRY_FACTORY;
    state.houseStartBlock = REGISTRY_START;
    await database.insert(schema.v2HouseVault).values(vaultRow(REGISTRY_VAULTS[0]!, REGISTRY_FACTORY, 1n));
    const healthy = await get();
    expect(healthy.status).toBe(200);
    expect(healthy.cacheControl).toBe("no-store");

    await database.insert(schema.v2HouseVault).values(vaultRow(UNREGISTERED_VAULT, REGISTRY_FACTORY, 2n));
    const alerting = await get();
    expect(alerting.status).toBe(503);
    expect(alerting.cacheControl).toBe("no-store");
    expect(alerting.body.alert).toBe(HOUSE_VAULT_UNREGISTERED);
  });
});

// /v2/health/registry: env's V2_CLEARINGHOUSE against the baked registry's. A production process refuses boot
// on a mismatch (ponder.config.ts); this route is for the dev, rehearsal and fork processes that keep running with it.
describe("/v2/health/registry through the exported v2 app", () => {
  const REGISTRY_ROUTE = "http://localhost/v2/health/registry";
  async function getRegistry() {
    const response = await app.request(REGISTRY_ROUTE);
    const text = await response.text();
    let body: Record<string, unknown>;
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { text }; }
    return { status: response.status, cacheControl: response.headers.get("cache-control"), body };
  }

  it("dev: answers 200, never cached, and reports the mismatch with the House factories and price sources it silences", async () => {
    const { status, cacheControl, body } = await getRegistry();
    expect(status).toBe(200);
    expect(cacheControl).toBe("no-store");
    expect(body).toMatchObject({
      ok: true, alert: null, production: false, clearinghouse: OTHER_CLEARINGHOUSE,
      registryClearinghouse: REGISTRY_CLEARINGHOUSE,
      mismatch: `V2_CLEARINGHOUSE ${OTHER_CLEARINGHOUSE} is not the baked registry's v2.contracts.clearinghouse ` +
        `(${REGISTRY_CLEARINGHOUSE})`,
    });
    const silenced = body.silenced as { house: string[]; priceSources: string[] };
    expect(silenced.house).toContain(`launch factory ${REGISTRY.contracts.houseVaultFactory}`);
    expect(silenced.priceSources.map((line) => line.split(" ")[0])).toContain("ChainlinkFeedSource");
  });

  it("production: the same mismatch answers 503 REGISTRY_CLEARINGHOUSE_MISMATCH", async () => {
    state.production = true;
    const { status, cacheControl, body } = await getRegistry();
    expect(status).toBe(503);
    expect(cacheControl).toBe("no-store");
    expect(body).toMatchObject({ ok: false, alert: REGISTRY_CLEARINGHOUSE_MISMATCH, production: true });
  });

  it("the registry's own Clearinghouse answers 200 with no mismatch, in production too (the positive control)", async () => {
    state.production = true;
    state.clearinghouse = REGISTRY_CLEARINGHOUSE;
    const { status, body } = await getRegistry();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, alert: null, mismatch: null, silenced: { house: [], priceSources: [] } });
  });
});
