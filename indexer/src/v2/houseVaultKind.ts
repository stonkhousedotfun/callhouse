/**
 * A House vault's epoch kind, decided by the FACTORY the vault was enumerated from
 * (the daily House vault design in callhouse-contracts):
 *
 *   legacy factory  the registry's launch factory (`v2.contracts.houseVaultFactory`). On v8 it is compiled before
 *                   and emits the 4-field VaultCreated: its vaults are weekly and have NO `weekly()` view
 *                   (calling it reverts), so the kind is known from the factory and `weekly()` is never called.
 *   kinded factory  a kinded factory. Each vault states its kind in its immutable `weekly()`; read it once.
 *   anything else   `unknown`: refused, labelled unknown. Never guessed, in either direction.
 *
 * ON v9 THE LAUNCH FACTORY IS NOT LEGACY. It is a kinded factory that creates DAILY vaults (the registry
 * records it as the `daily` entry, ops/markets/build-markets.mjs launchFactoryKind), and it emits only the 5-field
 * VaultCreated, whose `weekly` field kinds each vault (`stated` below). It is still in the legacy SET, which
 * would label weekly, but that rule is never reached for it: the only caller, src/v2/houseVault.ts recordVaultCreated,
 * gets no `stated` only from the `HouseVaultFactory:VaultCreated` (legacy 4-field topic) handler, a topic a v9
 * factory never emits; every 5-field log arrives through `HouseVaultFactoryKinded:VaultCreated` with `stated` set.
 *
 * A failed `weekly()` read on a kinded vault is `unknown`, NOT weekly. Mapping a failure to weekly is exactly the
 * guess that makes an RPC error on a daily vault look like a weekly one (the web's old readHouseVault shape).
 */
import { getAddress, isAddress, zeroAddress, type Address } from "viem";

import type { HouseRegistryShape } from "../../lib/v2/houseVaultSource";
import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";

export type HouseVaultKind = "weekly" | "daily" | "unknown";
export const HOUSE_VAULT_KINDS: readonly HouseVaultKind[] = ["weekly", "daily", "unknown"];

/** The registry fields the two factory sets are read from (the generated registry, or a test's fixture). */
type HouseFactoryRegistry = Pick<HouseRegistryShape, "contracts" | "house">;

/**
 * The registry's launch factory, from the generated registry; lowercase. Never typed here. Legacy on v8; on v9
 * a kinded factory whose vaults are kinded by the 5-field event's `weekly` instead (see the header).
 */
export function legacyHouseFactories(registry: HouseFactoryRegistry = V2_REGISTRY): ReadonlySet<string> {
  const f = registry.contracts.houseVaultFactory;
  return new Set(typeof f === "string" ? [f.toLowerCase()] : []);
}

/**
 * The kinded factories, DERIVED from the registry's `v2.house.factories` (ops/markets/build-markets.mjs
 * validates it; ops/markets/write-back-v8.mjs --house-deployment writes it from the deploy output). The registry's
 * `daily` entry IS the kinded factory; on v8 its `weekly` entry IS the launch
 * factory, which is legacy and never kinded. On v9 the `daily` entry IS the launch factory, which the
 * legacy rule keeps out of this set; its vaults are kinded by the 5-field event (`stated`), not by this set. Lowercase.
 *
 * Never hand-listed. Typing the kinded factory's address here would fix today's factory and miss the next one the
 * same way the empty set missed this one.
 *
 * A `daily` entry that equals a legacy factory is NOT kinded: the legacy rule wins, because calling `weekly()` on a
 * launch vault reverts and would turn a weekly vault into `unknown`. ops/markets/write-back-v8.mjs refuses a daily
 * write-back against the launch factory; build-markets.mjs checks only the weekly entry and does not refuse it.
 *
 * (Indexing a kinded factory's vaults also needs them in the registry's vault list, houseVaultSource.ts; and the
 * factory's own 5-field VaultCreated needs its own ponder source, which does not exist yet: until it
 * does, a daily vault gets no v2HouseVault row. See ponder.config.ts legacyHouseVaultFactoryAbi.)
 */
export function kindedHouseFactories(registry: HouseFactoryRegistry = V2_REGISTRY): ReadonlySet<string> {
  const legacy = legacyHouseFactories(registry);
  const kinded = new Set<string>();
  for (const f of registry.house?.factories ?? []) {
    const address = f.address.toLowerCase();
    if (f.kind === "daily" && !legacy.has(address)) kinded.add(address);
  }
  return kinded;
}

/** The production kinded set: the generated registry's, computed once at load. */
export const KINDED_HOUSE_FACTORIES: ReadonlySet<string> = kindedHouseFactories();

/**
 * (v9). `stated` is the `weekly` field of the factory's own 5-field `VaultCreated`. Only a kinded factory
 * emits that event, so when it is present it IS the answer, before the legacy rule: that rule exists because a launch
 * vault has no `weekly()` to call, and with the event's own field nothing is called. It matters for the v9 redeploy,
 * whose launch factory (`v2.contracts.houseVaultFactory`, V2_HOUSE_VAULT_FACTORY) is compiled AFTER kinding and
 * creates DAILY vaults: under the legacy rule alone every one of them was labelled weekly.
 */
export async function houseVaultKind(input: {
  factory: string;
  legacy: ReadonlySet<string>;
  kinded: ReadonlySet<string>;
  /** SEAM: the vault's `weekly()`. Called ONLY for a kinded factory's vault, and never when `stated` is given. */
  readWeekly: () => Promise<boolean>;
  /** The 5-field VaultCreated's `weekly`; undefined for the legacy 4-field event. */
  stated?: boolean;
}): Promise<HouseVaultKind> {
  if (input.stated !== undefined) return input.stated ? "weekly" : "daily";
  const factory = input.factory.toLowerCase();
  if (input.legacy.has(factory)) return "weekly";
  if (!input.kinded.has(factory)) return "unknown";
  try {
    return (await input.readWeekly()) ? "weekly" : "daily";
  } catch {
    return "unknown";
  }
}

/**
 * The kinded factories as a Ponder source: `HouseVaultFactoryKinded` in ponder.config.ts, indexed
 * with the generated 5-field `VaultCreated` (the launch factory keeps its own source and the legacy 4-field event).
 *
 * WHY FROM THE REGISTRY AND NOT AN ENV VAR. V2_HOUSE_VAULT_FACTORY is the LAUNCH factory, indexed with the legacy
 * topic; pointing it at a daily factory would watch a topic that factory never emits. And after the daily-only
 * redeploy `v2.contracts.houseVaultFactory` is null, so an env-only House configuration indexes no House vault at all.
 * The daily factories are already in the baked registry (`v2.house.factories`, written back by write-back-v8.mjs), so
 * they are read from there, like the price sources (src/v2/priceSourceRegistry.ts), and never typed by hand.
 *
 * THE REGISTRY DESCRIBES ONE DEPLOYMENT. A process indexing a different Clearinghouse (dev, rehearsal, a fork) must not
 * pick up the production daily factories, so they register only when `clearinghouse` IS the registry's. That drop is
 * the dev footing only: a V2_PRODUCTION=1 process refuses boot on it before this runs, and a dev process warns and
 * reports it at /v2/health/registry (src/v2/registryClearinghouse.ts).
 *
 * START BLOCK: the lowest kinded factory's registry `deployBlock`; a factory with none falls back to `envStartBlock`
 * (V2_HOUSE_START_BLOCK, the launch factory's block, which every later factory is created after). With neither, it
 * throws: a source with no start block would scan from genesis.
 *
 * FAIL CLOSED on a malformed entry: not an address, or the zero address, throws, as houseVaultSource.ts does.
 *
 * (v9): THE LAUNCH FACTORY IS SOURCED ON THIS TOPIC TOO, whenever the launch source is configured
 * (`envStartBlock` is V2_HOUSE_START_BLOCK, which lib/env.ts sets only with V2_HOUSE_VAULT_FACTORY), at that same block.
 * The v9 redeploy records ITS factory in `v2.contracts.houseVaultFactory` (the launch tooling; a change makes the
 * registry accept a daily launch factory), and that factory is compiled after kinding: it emits only the 5-field
 * event. The launch source watches the legacy topic, so without this every v9 House vault got no v2HouseVault row and
 * its queues never closed (closeMaturedQueue needs the row's epoch). The legacy launch factory never emits the
 * 5-field topic, so sourcing it here costs one filter and indexes nothing twice; exactly one of the two sources matches
 * any VaultCreated. A registry launch factory with no V2_HOUSE_START_BLOCK is not added: House stays off, as before.
 *
 * AND A FACTORY THE REGISTRY DOES NOT NAME, FOR ANY CLEARINGHOUSE. `envFactory` is V2_HOUSE_VAULT_FACTORY. When
 * the registry names no such House factory (neither `v2.contracts.houseVaultFactory` nor a `v2.house.factories` entry)
 * the process indexes a deployment of its own (dev, rehearsal, a fork), and that factory is sourced here at
 * V2_HOUSE_START_BLOCK whatever `clearinghouse` is. Before, the drop above kept it out: a v9 factory's
 * vaults were discovered by the HouseVault factory() fallback (houseDiscoveryEvent: the 5-field topic), but its own
 * 5-field VaultCreated reached no handler, so no vault got its v2HouseVault row and closeMaturedQueue never closed a
 * queue, while /v2/health/house-registry answered 200 outside production. The same one-source-per-
 * VaultCreated argument holds: a legacy factory never emits the 5-field topic, so its legacy source stays the only
 * match. A factory the registry DOES name keeps the rule above, so /v2/health/registry's `silenced` list stays true.
 */
export type KindedHouseFactorySources = {
  /** Checksummed, deduplicated, sorted. */
  addresses: readonly Address[];
  startBlock: number;
};

type KindedSourceRegistry = {
  contracts: { clearinghouse: string | null; houseVaultFactory?: string | null };
  house?: HouseRegistryShape["house"];
};

export function kindedHouseFactorySourcesFor(input: {
  /** V2_CLEARINGHOUSE. */
  clearinghouse: string | undefined;
  /** V2_HOUSE_START_BLOCK: set only with the launch factory (lib/env.ts). */
  envStartBlock: number | undefined;
  /** V2_HOUSE_VAULT_FACTORY: sourced here only when the registry names no such House factory. */
  envFactory?: string;
  registry: KindedSourceRegistry;
}): KindedHouseFactorySources | undefined {
  const { clearinghouse, envStartBlock, envFactory, registry } = input;
  const found = new Map<string, Address>();
  const blocks: number[] = [];
  // BEFORE the Clearinghouse check, on purpose: an unnamed env factory is a deployment of its
  // own, whose Clearinghouse is never the registry's, and after the check its vaults would get no v2HouseVault row.
  if (envFactory !== undefined && envStartBlock !== undefined && !namesHouseFactory(registry, envFactory)) {
    if (!isAddress(envFactory, { strict: false })) {
      throw new Error(`[callhouse/indexer] V2_HOUSE_VAULT_FACTORY="${envFactory}" is not an address.`);
    }
    const address = getAddress(envFactory);
    if (address === zeroAddress) throw new Error("[callhouse/indexer] V2_HOUSE_VAULT_FACTORY is the zero address.");
    found.set(address.toLowerCase(), address);
    blocks.push(envStartBlock);
  }
  const own = registry.contracts.clearinghouse;
  if (clearinghouse === undefined || own === null || own.toLowerCase() !== clearinghouse.toLowerCase()) {
    return sortedSources(found, blocks);
  }
  const kinded = kindedHouseFactories(registry);

  const launch = registry.contracts.houseVaultFactory ?? null;
  if (launch !== null && envStartBlock !== undefined) {
    if (!isAddress(launch, { strict: false })) {
      throw new Error(`[callhouse/indexer] registry v2.contracts.houseVaultFactory="${launch}" is not an address.`);
    }
    const address = getAddress(launch);
    if (address === zeroAddress) throw new Error("[callhouse/indexer] registry v2.contracts.houseVaultFactory is the zero address.");
    found.set(address.toLowerCase(), address);
    blocks.push(envStartBlock);
  }
  for (const f of registry.house?.factories ?? []) {
    if (!kinded.has(f.address.toLowerCase())) continue;
    if (!isAddress(f.address, { strict: false })) {
      throw new Error(`[callhouse/indexer] registry house factory ${f.kind}="${f.address}" is not an address.`);
    }
    const address = getAddress(f.address);
    if (address === zeroAddress) throw new Error(`[callhouse/indexer] registry house factory ${f.kind} is the zero address.`);
    const block = f.deployBlock ?? envStartBlock ?? null;
    if (block === null || !Number.isSafeInteger(block) || block <= 0) {
      throw new Error(
        `[callhouse/indexer] registry house factory ${f.kind} ${address} has no deployBlock and V2_HOUSE_START_BLOCK is unset: ` +
          "record its deploy block in v2.house.factories (ops/markets/write-back-v8.mjs) and regenerate the registry.",
      );
    }
    found.set(address.toLowerCase(), address);
    blocks.push(block);
  }
  return sortedSources(found, blocks);
}

/** True when `factory` is the registry's launch factory or one of its `v2.house.factories` entries. */
function namesHouseFactory(registry: KindedSourceRegistry, factory: string): boolean {
  const f = factory.toLowerCase();
  const launch = registry.contracts.houseVaultFactory;
  if (typeof launch === "string" && launch.toLowerCase() === f) return true;
  return (registry.house?.factories ?? []).some((entry) => entry.address.toLowerCase() === f);
}

function sortedSources(found: ReadonlyMap<string, Address>, blocks: readonly number[]): KindedHouseFactorySources | undefined {
  if (found.size === 0) return undefined;
  const addresses = [...found.values()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return { addresses, startBlock: Math.min(...blocks) };
}

/**
 * What a process whose V2_CLEARINGHOUSE is `clearinghouse` sources. ponder.config.ts (the source), lib/registry.ts (the
 * handler gates) and houseVault.ts (the unregistered-vault alert) all call this with the same env values, so the three
 * cannot disagree. It does not import lib/env: env.ts throws at import without a configured deployment. `envFactory`
 * (V2_HOUSE_VAULT_FACTORY) is positional and required, so no caller can leave it out and disagree with the others.
 */
export function v2KindedHouseFactorySources(
  clearinghouse: string | undefined,
  envStartBlock: number | undefined,
  envFactory: string | undefined,
): KindedHouseFactorySources | undefined {
  return kindedHouseFactorySourcesFor({ clearinghouse, envStartBlock, envFactory, registry: V2_REGISTRY });
}

/**
 * The factory and start block the HouseVault source (lib/v2/houseVaultSource.ts) is decided from: the launch
 * factory when V2_HOUSE_VAULT_FACTORY is set (unchanged), otherwise the first kinded factory. Undefined when neither
 * is configured, and then no House handler is live.
 *
 * The vault list itself is the registry's either way, so it covers weekly and daily vaults alike, and its start block
 * is the lowest of this one and every recorded House factory deploy block (houseVaultSourceFor). Only the factory()
 * FALLBACK differs: it discovers with whichever factory anchors it.
 */
export function houseSourceAnchor(
  launchFactory: Address | undefined,
  envStartBlock: number | undefined,
  kinded: KindedHouseFactorySources | undefined,
): { factory: Address; startBlock: number; kind: "launch" | "kinded" } | undefined {
  if (launchFactory !== undefined && envStartBlock !== undefined) {
    return { factory: launchFactory, startBlock: envStartBlock, kind: "launch" };
  }
  if (kinded !== undefined && kinded.addresses.length > 0) {
    return { factory: kinded.addresses[0]!, startBlock: kinded.startBlock, kind: "kinded" };
  }
  return undefined;
}

/**
 * The kind the registry records for its LAUNCH factory (`v2.contracts.houseVaultFactory`), restated rule for
 * rule from ops/markets/build-markets.mjs launchFactoryKind (keeper/src/v2/registry.ts has the same copy):
 *   "weekly"  no launch address, no entry names it (the implied legacy launch), or the weekly entry does (v8);
 *   "daily"   the daily entry names it (v9: a kinded factory that creates daily vaults and emits the 5-field event);
 *   null      entries of BOTH kinds name it: one launch factory, two kinds, a record build-markets refuses.
 */
export function launchFactoryKind(registry: HouseFactoryRegistry = V2_REGISTRY): "weekly" | "daily" | null {
  const launch = registry.contracts.houseVaultFactory;
  if (typeof launch !== "string" || !isAddress(launch, { strict: false })) return "weekly";
  const kinds = new Set(
    (registry.house?.factories ?? [])
      .filter((f) => isAddress(f.address, { strict: false }) && f.address.toLowerCase() === launch.toLowerCase())
      .map((f) => f.kind),
  );
  if (kinds.has("weekly") && kinds.has("daily")) return null;
  return kinds.has("daily") ? "daily" : "weekly";
}

/**
 * Which `VaultCreated` the HouseVault
 * source's factory() FALLBACK (lib/v2/houseVaultSource.ts: a factory the registry does not name, or a registry with no
 * House vault yet) discovers the anchoring factory's vaults with. ponder.config.ts houseVaultContract builds the filter
 * from this answer. Earlier a launch anchor ALWAYS used the legacy 4-field topic (0xf4c8fe3d…), which a factory
 * compiled after kinding never emits, so a v9 launch factory in factory() mode discovered ZERO House vaults, silently.
 *
 *   "legacy"  the 4-field topic, ONLY for a factory the registry records as legacy: the registry's launch factory
 *             when launchFactoryKind is "weekly" (v8), or another `v2.house.factories` entry recorded `weekly`.
 *   "kinded"  the generated 5-field topic (0xeef0325f…) for everything else: a kinded anchor (unchanged); the launch
 *             factory when the registry records it `daily` (v9); another entry recorded `daily`; and a factory the
 *             registry does not name at all (dev, rehearsal, a fork). The last is an inference, stated here: every
 *             factory compiled from today's contracts is a kinded one, and the only legacy factory is the v8
 *             launch factory, which the v8 registry names. It is wrong only for a legacy factory this image's
 *             registry does not name (a v8 run-off indexer on a v9-baked image); the registry's launch kind alone
 *             would label that one wrong as well.
 *
 * THROWS on a launch factory the registry records under both kinds: the event form would be a guess, and a wrong guess
 * discovers nothing and says nothing.
 */
export function houseDiscoveryEvent(
  anchor: { factory: string; kind: "launch" | "kinded" },
  registry: HouseFactoryRegistry = V2_REGISTRY,
): "legacy" | "kinded" {
  if (anchor.kind === "kinded") return "kinded";
  const factory = anchor.factory.toLowerCase();
  const launch = registry.contracts.houseVaultFactory;
  if (typeof launch === "string" && launch.toLowerCase() === factory) {
    const kind = launchFactoryKind(registry);
    if (kind === null) {
      throw new Error(
        `[callhouse/indexer] registry v2.contracts.houseVaultFactory ${launch} is recorded as BOTH the weekly and the daily ` +
          "House factory (v2.house.factories), so the VaultCreated its factory() fallback must watch is unknown. One launch " +
          "factory has one kind (weekly on v8, daily on v9): fix ops/markets/tier1.json (build-markets.mjs refuses this " +
          "record) and regenerate the registry.",
      );
    }
    return kind === "weekly" ? "legacy" : "kinded";
  }
  const recorded = (registry.house?.factories ?? []).filter((f) => f.address.toLowerCase() === factory).map((f) => f.kind);
  return recorded.includes("weekly") ? "legacy" : "kinded";
}
