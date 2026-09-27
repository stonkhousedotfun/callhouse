import { getAddress, isAddress, zeroAddress, type Address } from "viem";

import { V2_REGISTRY } from "./marketRegistry.generated";

/**
 * Where the HouseVault source gets its addresses: the generated registry's vault list, not `factory()`.
 *
 * WHY. With `address: factory(...)` Ponder cannot bloom-test the vault addresses, only the topics
 * (ponder@0.17.10 src/sync-realtime/bloom.ts: a factory filter sets isAddressInBloom = true), and the HouseVault
 * ABI's topics include the ERC-20 `Transfer` selector. Some token Transfer lands in almost every block on 4663, so
 * realtime issued an `eth_getLogs({ blockHash })` for nearly every block (measured on
 * chain 4663 in production). A plain address list lets the bloom test
 * the vaults themselves, so `eth_getLogs` runs only where a vault may have logged.
 *
 * WHY A STATIC LIST IS SAFE. Every House vault, weekly or daily, is written back into the registry
 * (ops/markets/tier1.json `markets[].v2.house`), and a registry change already forces a regenerate
 * (indexer/scripts/gen-v2-registry.mjs) and a redeploy. The list is never typed here.
 *
 * WHAT IS LOST, AND HOW IT IS CAUGHT. A vault the factory creates before the registry names it is not indexed
 * until the registry is regenerated and the indexer redeployed. The factory stays a source of its own
 * (HouseVaultFactory:VaultCreated), so such a vault is still DETECTED: the handler logs HOUSE_VAULT_UNREGISTERED
 * and /v2/health/house-registry reports it with a 503 (src/api/v2/health.ts).
 *
 * FALLBACK TO factory(), ON PURPOSE, IN EXACTLY TWO CASES. The registry describes one deployment, like the price
 * sources (src/v2/priceSourceRegistry.ts). (1) A process whose V2_HOUSE_VAULT_FACTORY is not one of the registry's
 * House factories indexes a different deployment (dev, rehearsal, a fork), and the production vault list would be
 * the wrong one, so it keeps discovering its own vaults. (2) A registry that names the factory but no vault yet
 * (the window between factory deploy and createVault) keeps discovery too, because an EMPTY address array is not
 * "no vaults" to Ponder: `address: []` passes its bloom test on every block and would match every contract's logs.
 * Either fallback is reported, never silent: the config logs it and /v2/health/house-registry returns
 * `mode: "factory"` with the reason.
 *
 * NOT IN PRODUCTION. Case (1) is also what a PRODUCTION service looks like when it runs a newer env on an
 * image built before the registry regen: the v9 launch factory is not in a v8-era registry. The fallback then watched
 * the launch factory's LEGACY 4-field VaultCreated (ponder.config.ts houseVaultContract), which a factory compiled
 * with kinding never emits, so it discovered zero House vaults while the route said ok (measured on a v9
 * fork). A change makes the fallback watch the event the factory emits (houseVaultKind.ts houseDiscoveryEvent), and
 * routes that factory's 5-field VaultCreated to its handler (houseVaultKind.ts kindedHouseFactorySourcesFor
 * sources a V2_HOUSE_VAULT_FACTORY the registry does not name), so its vaults get their v2HouseVault rows. That process
 * is still wrong: its vault list is not the registry's, and it pays factory() mode's per-block eth_getLogs. The process cannot tell that from a dev stack by itself, so the env says which it is (lib/env.ts
 * V2_PRODUCTION). With V2_PRODUCTION=1, a V2_HOUSE_VAULT_FACTORY that is not the registry's
 * v2.contracts.houseVaultFactory refuses boot by name (assertProductionHouseFactory, HOUSE_FACTORY_NOT_REGISTRY),
 * and any factory() fallback answers 503 on /v2/health/house-registry (HOUSE_SOURCE_FACTORY_FALLBACK), because a
 * production registry with its factory but no vault yet is a cost regression worth a page, not a dev footing.
 *
 * FAIL CLOSED on a malformed list: a vault entry that is not an address, or is the zero address, throws. A source
 * pointed at the zero address indexes nothing and looks configured.
 */

/** The alert name, in the handler's log line and in /v2/health/house-registry. Grep for this. */
export const HOUSE_VAULT_UNREGISTERED = "HOUSE_VAULT_UNREGISTERED";

/**
 * A production process (V2_PRODUCTION=1) whose V2_HOUSE_VAULT_FACTORY is not the baked registry's
 * v2.contracts.houseVaultFactory: the boot refusal's name, and /v2/health/house-registry's alert if one ever runs.
 */
export const HOUSE_FACTORY_NOT_REGISTRY = "HOUSE_FACTORY_NOT_REGISTRY";

/** A production process whose House source is in factory() fallback: /v2/health/house-registry's alert. */
export const HOUSE_SOURCE_FACTORY_FALLBACK = "HOUSE_SOURCE_FACTORY_FALLBACK";

export type HouseRegistryShape = {
  contracts: { houseVaultFactory?: string | null };
  house?: {
    factories: readonly { kind: string; address: string; deployBlock: number | null }[];
    /** `ticker` is null for `v2.contracts.houseVault` when no market names it (indexer/scripts/gen-v2-registry.mjs). */
    vaults: readonly { ticker: string | null; kind: string; address: string }[];
  };
};

export type HouseVaultSource =
  | {
      mode: "registry";
      /** Checksummed, deduplicated, sorted: the HouseVault source's `address`. */
      addresses: readonly Address[];
      /** Lowercase copy of `addresses`, for membership tests. */
      registered: ReadonlySet<string>;
      startBlock: number;
    }
  | { mode: "factory"; reason: string; startBlock: number };

export function houseVaultSourceFor(input: {
  factory: Address;
  /** V2_HOUSE_START_BLOCK: where the HouseVaultFactory source starts. */
  envStartBlock: number;
  registry: HouseRegistryShape;
}): HouseVaultSource {
  const { factory, envStartBlock, registry } = input;
  const house = registry.house;
  if (house === undefined) {
    return {
      mode: "factory",
      reason: "the generated registry carries no house block; regenerate it with indexer/scripts/gen-v2-registry.mjs",
      startBlock: envStartBlock,
    };
  }

  // The launch factory is v2.contracts.houseVaultFactory AND the house.factories entry of the launch kind: `weekly` on
  // v8, `daily` on v9 (build-markets launchFactoryKind: a weekly entry must be the launch factory, and one address is
  // never both kinds). Both are read so a registry that has only the first still recognises its own deployment.
  const factories = new Map<string, number | null>();
  const launch = registry.contracts.houseVaultFactory;
  if (typeof launch === "string") factories.set(launch.toLowerCase(), null);
  for (const f of house.factories) {
    const known = factories.get(f.address.toLowerCase()) ?? null;
    factories.set(f.address.toLowerCase(), f.deployBlock ?? known);
  }
  if (!factories.has(factory.toLowerCase())) {
    return {
      mode: "factory",
      reason: `V2_HOUSE_VAULT_FACTORY ${factory} is not a registry House factory; this process indexes another deployment`,
      startBlock: envStartBlock,
    };
  }

  const seen = new Map<string, Address>();
  for (const v of house.vaults) {
    const name = `${v.ticker ?? "v2.contracts.houseVault"}/${v.kind}`;
    if (!isAddress(v.address, { strict: false })) {
      throw new Error(`[callhouse/indexer] registry house vault ${name}="${v.address}" is not an address.`);
    }
    const address = getAddress(v.address);
    if (address === zeroAddress) {
      throw new Error(`[callhouse/indexer] registry house vault ${name} is the zero address.`);
    }
    seen.set(address.toLowerCase(), address);
  }
  if (seen.size === 0) {
    return {
      mode: "factory",
      reason: "the registry names this House factory but no House vault yet",
      startBlock: envStartBlock,
    };
  }

  // The earliest recorded start: every vault is created at or after its factory's deploy block, so the earliest
  // House factory deploy block is a safe lower bound. Starting before a vault exists only backfills empty blocks;
  // starting after it drops its logs silently, so the env block wins whenever it is earlier.
  const recorded = [...factories.values()].filter((b): b is number => b !== null);
  const startBlock = Math.min(envStartBlock, ...recorded);

  const addresses = [...seen.values()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return { mode: "registry", addresses, registered: new Set(seen.keys()), startBlock };
}

/**
 * Why `factory` is not the registry's LAUNCH factory (v2.contracts.houseVaultFactory, which build-markets
 * records as the house.factories entry of the launch kind: weekly on v8, daily on v9), or null when it is. V2_HOUSE_VAULT_FACTORY is the launch factory by
 * definition (ops/v2-env.mjs renders it from that key), so another registry House factory in that slot is a mismatch too.
 */
export function launchFactoryMismatch(factory: Address, registry: Pick<HouseRegistryShape, "contracts">): string | null {
  const launch = registry.contracts.houseVaultFactory;
  if (typeof launch === "string" && launch.toLowerCase() === factory.toLowerCase()) return null;
  return `V2_HOUSE_VAULT_FACTORY ${factory} is not the baked registry's v2.contracts.houseVaultFactory ` +
    `(${typeof launch === "string" ? launch : "null"})`;
}

/**
 * The boot refusal. In a production process a launch factory the baked registry does not name means the
 * image was built before the registry regen (or the env is another deployment's), and the factory() fallback it would
 * start watched a topic a kinded factory never emits. The topic (houseDiscoveryEvent) and
 * the VaultCreated handler (kindedHouseFactorySourcesFor) are fixed; the refusal stays, because the vault list is not the
 * registry's and the fallback's per-block eth_getLogs is a production cost regression. Refuse by name instead of
 * starting a House source that indexes another deployment. Not production, or no launch factory: nothing to
 * check, and the fallback stays the dev footing it was.
 */
export function assertProductionHouseFactory(input: {
  production: boolean;
  factory: Address | undefined;
  registry: Pick<HouseRegistryShape, "contracts">;
}): void {
  if (!input.production || input.factory === undefined) return;
  const mismatch = launchFactoryMismatch(input.factory, input.registry);
  if (mismatch === null) return;
  throw new Error(
    `[callhouse/indexer] ${HOUSE_FACTORY_NOT_REGISTRY}: ${mismatch}, and V2_PRODUCTION=1 says this process indexes ` +
      "the deployment its baked registry describes. Refusing to start: this image's registry describes another " +
      "deployment, so its House vaults would come from factory() discovery and their VaultCreated would reach no " +
      "handler (no v2HouseVault row for any of them). Write the deployment back into ops/markets/tier1.json, regenerate " +
      "indexer/lib/v2/marketRegistry.generated.ts (ops/v2/post-broadcast-regen.mjs), rebuild and redeploy. A process " +
      "that indexes another deployment on purpose (dev, rehearsal, fork, a run-off) leaves V2_PRODUCTION unset.",
  );
}

/** True when the registry list is the source and does not name `vault`; always false under the factory fallback. */
export function isUnregisteredHouseVault(source: HouseVaultSource, vault: string): boolean {
  return source.mode === "registry" && !source.registered.has(vault.toLowerCase());
}

/** The alert line the VaultCreated handler logs for an unregistered vault. One line, greppable by its name. */
export function unregisteredHouseVaultAlert(input: { vault: string; factory: string; block: bigint | number }): string {
  return (
    `[callhouse/indexer] ${HOUSE_VAULT_UNREGISTERED} vault=${input.vault} factory=${input.factory} block=${input.block}: ` +
    "the factory created a House vault the registry does not list, so its events are NOT indexed. Write it into " +
    "ops/markets/tier1.json markets[].v2.house, regenerate indexer/lib/v2/marketRegistry.generated.ts and redeploy."
  );
}

/** One indexed v2HouseVault row, as /v2/health/house-registry reads it. */
export type IndexedHouseVault = { vault: string; factory: string; createdBlock: bigint };

export type HouseRegistryAlert =
  | typeof HOUSE_VAULT_UNREGISTERED
  | typeof HOUSE_FACTORY_NOT_REGISTRY
  | typeof HOUSE_SOURCE_FACTORY_FALLBACK;

/** What the route knows beside the source and the rows: the env's V2_PRODUCTION and launchFactoryMismatch's answer. */
export type HouseRegistryContext = { production: boolean; launchMismatch: string | null };

export type HouseRegistryHealth = {
  /** False exactly when `alert` is set; the route answers 503 then. */
  ok: boolean;
  alert: HouseRegistryAlert | null;
  /** One line on why `alert` is set; null when ok. */
  message: string | null;
  /** V2_PRODUCTION: whether a launch-factory mismatch and the factory() fallback are alerts. */
  production: boolean;
  mode: HouseVaultSource["mode"];
  /** Why the factory() fallback is in force; null in registry mode. */
  reason: string | null;
  /** The registry list the HouseVault source filters on; empty under the factory fallback. */
  registered: string[];
  /** v2HouseVault rows, i.e. every VaultCreated the factory source has delivered. */
  indexed: number;
  unregistered: { vault: string; factory: string; createdBlock: string }[];
};

/**
 * The durable half of the alert. The handler's log line is lost with the log; the v2HouseVault row it wrote beside
 * it is not, so this compares every indexed VaultCreated with the registry list the source filters on.
 *
 * In a production process (context.production) two states that are the dev footing elsewhere are alerts,
 * checked first because each hides the vault check: a launch factory the registry does not name (the boot refusal
 * normally stops that process first; this is the route's own copy), then any factory() fallback, whose `unregistered`
 * is empty by construction. Outside production both stay 200 with `mode: "factory"` and the reason, as before.
 */
export function houseRegistryHealth(
  source: HouseVaultSource,
  rows: readonly IndexedHouseVault[],
  context: HouseRegistryContext,
): HouseRegistryHealth {
  const unregistered = rows
    .filter((row) => isUnregisteredHouseVault(source, row.vault))
    .map((row) => ({ vault: row.vault, factory: row.factory, createdBlock: row.createdBlock.toString() }))
    .sort((a, b) => (a.vault < b.vault ? -1 : 1));
  let alert: HouseRegistryAlert | null = null;
  let message: string | null = null;
  if (context.production && context.launchMismatch !== null) {
    alert = HOUSE_FACTORY_NOT_REGISTRY;
    message = `${context.launchMismatch} in a V2_PRODUCTION=1 process: the image predates the registry regen; ` +
      "regenerate indexer/lib/v2/marketRegistry.generated.ts and redeploy";
  } else if (context.production && source.mode === "factory") {
    alert = HOUSE_SOURCE_FACTORY_FALLBACK;
    message = `the House source is in factory() discovery in a V2_PRODUCTION=1 process (${source.reason})`;
  } else if (unregistered.length > 0) {
    alert = HOUSE_VAULT_UNREGISTERED;
    message = `${unregistered.length} indexed House vault(s) the registry list does not name: their events are NOT indexed`;
  }
  return {
    ok: alert === null,
    alert,
    message,
    production: context.production,
    mode: source.mode,
    reason: source.mode === "factory" ? source.reason : null,
    registered: source.mode === "registry" ? [...source.addresses] : [],
    indexed: rows.length,
    unregistered,
  };
}

/**
 * What a process configured with this factory and start block indexes. ponder.config.ts (the source), the
 * VaultCreated handler (the alert) and /v2/health/house-registry (the flag) all call this with the same env values,
 * so the three cannot disagree. Like v2PriceSources it does not import lib/env, so it stays testable without a deployment.
 */
export function v2HouseVaultSource(factory: Address, envStartBlock: number): HouseVaultSource {
  return houseVaultSourceFor({ factory, envStartBlock, registry: V2_REGISTRY as unknown as HouseRegistryShape });
}

/** launchFactoryMismatch against the generated registry, for /v2/health/house-registry. */
export function v2LaunchFactoryMismatch(factory: Address): string | null {
  return launchFactoryMismatch(factory, V2_REGISTRY as unknown as HouseRegistryShape);
}

/** assertProductionHouseFactory against the generated registry. ponder.config.ts calls it before any House source. */
export function v2AssertProductionHouseFactory(production: boolean, factory: Address | undefined): void {
  assertProductionHouseFactory({ production, factory, registry: V2_REGISTRY as unknown as HouseRegistryShape });
}
