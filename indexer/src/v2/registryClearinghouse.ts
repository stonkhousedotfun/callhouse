/**
 * The baked registry describes ONE deployment, and two source groups register only when env's
 * V2_CLEARINGHOUSE is that deployment's Clearinghouse: the House factory source (houseVaultKind.ts
 * kindedHouseFactorySourcesFor) and the shared price sources (priceSourceRegistry.ts priceSourcesFor). For another
 * Clearinghouse each drops itself and returns undefined. That is right for a dev, rehearsal or fork process, which
 * indexes another deployment on purpose. It is wrong in production, and it was silent: a change measured the v9 env on
 * an image whose registry predates the regen, on a v9 fork. 25 event groups were never fetched (every House vault event,
 * every Chainlink/UniV3/DataStreams source event), `/v2/house` was empty while the chain had 2 armed vaults,
 * `/v2/health` said ok, and the log had no warning.
 *
 * The process cannot tell a stale image from a deliberate dev setup by itself; lib/env.ts V2_PRODUCTION says which.
 *
 *   V2_PRODUCTION=1  the mismatch refuses boot with one line, REGISTRY_CLEARINGHOUSE_MISMATCH, naming what would go
 *                    silent and the fix (ponder.config.ts calls v2AssertRegistryClearinghouse before any source).
 *   unset / 0        today's behaviour (both groups absent) plus a loud warning, and /v2/health/registry reports it.
 *
 * Never regenerates the registry at boot: the image is what it is, so this refuses and names the fix.
 *
 * Like priceSourceRegistry.ts and houseVaultKind.ts this does not import lib/env (env.ts throws at import without a
 * configured deployment), so the decision stays testable with a fixture registry.
 */
import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";
import type { HouseRegistryShape } from "../../lib/v2/houseVaultSource";
import { kindedHouseFactories } from "./houseVaultKind";
import { PRICE_SOURCE_NAMES, PRICE_SOURCE_REGISTRY_KEY } from "./priceSourceRegistry";

/** The boot refusal's name and /v2/health/registry's alert. Grep for this. */
export const REGISTRY_CLEARINGHOUSE_MISMATCH = "REGISTRY_CLEARINGHOUSE_MISMATCH";

type ClearinghouseRegistry = {
  contracts: {
    clearinghouse: string | null;
    houseVaultFactory?: string | null;
    sources?: Readonly<Record<string, string | null>>;
  };
  house?: HouseRegistryShape["house"];
};

export type RegistryClearinghouseCheck = {
  /** One sentence on why env's Clearinghouse is not the baked registry's; null when it is, or when v2 is off. */
  mismatch: string | null;
  /** V2_CLEARINGHOUSE as configured; null when v2 is off. */
  clearinghouse: string | null;
  /** The baked registry's v2.contracts.clearinghouse. */
  registryClearinghouse: string | null;
  /**
   * What the baked registry names and this process therefore does not source. Empty when `mismatch` is null.
   * `house`: the launch factory (v2.contracts.houseVaultFactory) and the kinded daily factories (v2.house.factories).
   * `priceSources`: every non-null v2.contracts.sources entry, by Ponder source name.
   */
  silenced: { house: string[]; priceSources: string[] };
};

function silencedHouse(registry: ClearinghouseRegistry): string[] {
  const out: string[] = [];
  const launch = registry.contracts.houseVaultFactory ?? null;
  if (typeof launch === "string") out.push(`launch factory ${launch}`);
  const kinded = kindedHouseFactories({ contracts: registry.contracts, house: registry.house });
  for (const f of registry.house?.factories ?? []) {
    if (kinded.has(f.address.toLowerCase())) out.push(`${f.kind} factory ${f.address}`);
  }
  return out;
}

function silencedPriceSources(registry: ClearinghouseRegistry): string[] {
  const out: string[] = [];
  for (const name of PRICE_SOURCE_NAMES) {
    const raw = registry.contracts.sources?.[PRICE_SOURCE_REGISTRY_KEY[name]] ?? null;
    if (raw !== null) out.push(`${name} ${raw}`);
  }
  return out;
}

export function registryClearinghouseCheck(
  clearinghouse: string | undefined,
  registry: ClearinghouseRegistry,
): RegistryClearinghouseCheck {
  const own = registry.contracts.clearinghouse;
  const none = { house: [], priceSources: [] };
  if (clearinghouse === undefined) {
    return { mismatch: null, clearinghouse: null, registryClearinghouse: own, silenced: none };
  }
  if (own !== null && own.toLowerCase() === clearinghouse.toLowerCase()) {
    return { mismatch: null, clearinghouse, registryClearinghouse: own, silenced: none };
  }
  return {
    mismatch: `V2_CLEARINGHOUSE ${clearinghouse} is not the baked registry's v2.contracts.clearinghouse (${own ?? "null"})`,
    clearinghouse,
    registryClearinghouse: own,
    silenced: { house: silencedHouse(registry), priceSources: silencedPriceSources(registry) },
  };
}

/** The one line: the mismatch, then what it silences. Shared by the boot refusal and the dev warning. */
export function registryClearinghouseLine(check: RegistryClearinghouseCheck): string {
  const house = check.silenced.house.length === 0
    ? "no House factory (the registry names none)"
    : `no House factory source (${check.silenced.house.join(", ")})`;
  const prices = check.silenced.priceSources.length === 0
    ? "no price source (the registry names none)"
    : `no price source (${check.silenced.priceSources.join(", ")})`;
  return `${REGISTRY_CLEARINGHOUSE_MISMATCH}: ${check.mismatch}, so this process registers ${house} and ${prices}: ` +
    "their events are never fetched";
}

/**
 * The boot refusal. A production process (V2_PRODUCTION=1) whose V2_CLEARINGHOUSE is not the baked registry's
 * refuses by name. Outside production the mismatch is the dev footing: it warns (through `warn`, console.warn by
 * default) and returns, and both source groups stay absent exactly as before.
 */
export function assertRegistryClearinghouse(input: {
  production: boolean;
  clearinghouse: string | undefined;
  registry: ClearinghouseRegistry;
  warn?: (line: string) => void;
}): void {
  const check = registryClearinghouseCheck(input.clearinghouse, input.registry);
  if (check.mismatch === null) return;
  const line = registryClearinghouseLine(check);
  if (input.production) {
    throw new Error(
      `[callhouse/indexer] ${line}. V2_PRODUCTION=1 says this process indexes the deployment its baked registry ` +
        "describes, so the image predates the registry regen (or the env is another deployment's). Refusing to start. " +
        "Write the deployment back into ops/markets/tier1.json, regenerate indexer/lib/v2/marketRegistry.generated.ts " +
        "(ops/v2/post-broadcast-regen.mjs), rebuild and redeploy. A process that indexes another deployment on purpose " +
        "(dev, rehearsal, fork, a run-off) leaves V2_PRODUCTION unset.",
    );
  }
  (input.warn ?? console.warn)(
    `[callhouse/indexer] WARNING ${line}. Expected for a dev, rehearsal or fork process; a production process must ` +
      "set V2_PRODUCTION=1 and would refuse to start here. Reported at /v2/health/registry.",
  );
}

export type RegistryHealth = RegistryClearinghouseCheck & {
  /** False exactly when `alert` is set; the route answers 503 then. */
  ok: boolean;
  /** Set only in a production process: boot refuses that case first, so this is the route's own copy. */
  alert: typeof REGISTRY_CLEARINGHOUSE_MISMATCH | null;
  /** V2_PRODUCTION. */
  production: boolean;
};

/**
 * /v2/health/registry's body. A mismatch outside production is reported (mismatch, silenced) and stays 200: a dev,
 * rehearsal or fork process indexes another deployment on purpose, and an uptime check must not page on it.
 */
export function registryHealth(check: RegistryClearinghouseCheck, production: boolean): RegistryHealth {
  const alert = production && check.mismatch !== null ? REGISTRY_CLEARINGHOUSE_MISMATCH : null;
  return { ok: alert === null, alert, production, ...check };
}

/** registryClearinghouseCheck against the generated registry, for /v2/health/registry. */
export function v2RegistryClearinghouseCheck(clearinghouse: string | undefined): RegistryClearinghouseCheck {
  return registryClearinghouseCheck(clearinghouse, V2_REGISTRY as unknown as ClearinghouseRegistry);
}

/** assertRegistryClearinghouse against the generated registry. ponder.config.ts calls it before any source. */
export function v2AssertRegistryClearinghouse(production: boolean, clearinghouse: string | undefined): void {
  assertRegistryClearinghouse({ production, clearinghouse, registry: V2_REGISTRY as unknown as ClearinghouseRegistry });
}
