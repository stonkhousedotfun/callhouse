import { getAddress, type Address } from "viem";

import { USDG } from "../contracts";
import * as generated from "../markets.generated";
import type { ConfigResponse } from "./api-types";
import { PRICE_TICK, UNIT, UNITS_PER_SHARE } from "./payoff";

/** Registry exports are generated from ops/markets/tier1.json. Null means not deployed. */
type V2Addresses = ConfigResponse["contracts"];
type AddressKey = Exclude<keyof V2Addresses, "sources">;

function value(name: string): unknown {
  return (generated as unknown as Record<string, unknown>)[name];
}

function address(raw: unknown): Address | null {
  if (typeof raw !== "string") return null;
  try { return getAddress(raw); } catch { return null; }
}

const rawContracts = (value("V2_CONTRACTS") ?? null) as Partial<V2Addresses> | null;
const addressKeys = [
  "clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
  "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor",
  "accessManager", "stockZap",
] as const satisfies readonly AddressKey[];
const sourceKeys = ["chainlink", "univ3", "dataStreams"] as const;

/**
 * Exported so a test can hold this list against the GENERATOR's list. They are two copies of one
 * key set in two languages, and the stockZap mismatch was exactly the case where they disagreed and nothing noticed:
 * `stockZap` was here and not in `V2_CONTRACT_NAMES`, so the key existed, could never be filled,
 * and every consumer read "not configured" forever.
 */
export const V2_ADDRESS_KEYS = addressKeys;

export const V2_DEPLOYMENT = {
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663),
  interfaceVersion: generated.V2_REGISTRY.interfaceVersion,
  contracts: Object.fromEntries(addressKeys.map((key) => [key, address(rawContracts?.[key])])) as Record<AddressKey, Address | null>,
  sources: Object.fromEntries(sourceKeys.map((key) => [key, address(rawContracts?.sources?.[key])])) as Record<(typeof sourceKeys)[number], Address | null>,
  fees: (value("V2_FEES") ?? null) as Record<string, unknown> | null,
  defaults: (value("V2_DEFAULTS") ?? null) as Record<string, unknown> | null,
  constants: { unit: UNIT.toString(), unitsPerShare: Number(UNITS_PER_SHARE), priceTick: Number(PRICE_TICK) },
} as const;

/**
 * OVERRIDABLE ADDRESS KEYS — addresses an environment override may supply.
 *
 *
 * These three contracts are outside the eleven `V2_CONTRACT_NAMES` (`web/scripts/gen-markets.mjs`,
 * `ops/markets/build-markets.mjs`) and outside `api-schema.ts` `contracts`. They used to have NO key in
 * the generated registry at all, and this comment said so. That stopped being true when a later change
 * made `earnVault` and `rewardsDistributorLender` EXTERNAL keys that `V2_CONTRACTS` copies through from
 * `v2.contracts` (`build-markets.mjs` `V2_EXTERNAL_CONTRACT_NAMES`): the v8 write-back filled `earnVault`
 * while `/lend` kept reading "not deployed", because only the override was consulted. So they now
 * resolve like everything else, REGISTRY FIRST ({REGISTRY_NAME} maps each to its `v2.contracts` key),
 * then a validated `NEXT_PUBLIC_*` override where the registry is silent, else unconfigured — never a
 * literal null constant at the call site.
 *
 * `stockZap` is the odd member. It is in {addressKeys} below and `.optional()` in `api-schema.ts`
 * `contracts`, and the registry fills it too: `stockZap` is the seventh external in
 * `build-markets.mjs` `V2_EXTERNAL_CONTRACT_NAMES`, and tier1.json records the deployed StockZap. It is
 * deliberately NOT removed from {addressKeys}: it is wired to live code (`zapTx.ts`, `EarnMarket.tsx`),
 * and deleting the key turns a working feature into a compile error at best and a silently absent one at
 * worst. What sets it apart is the indexer cross-check, which for this key alone does NOT block trading:
 * see {NON_BLOCKING_ADDRESS_KEYS} and {v2StockZapMismatch}.
 *
 * THE READS ARE WRITTEN OUT ONE PER KEY ON PURPOSE. `next build` inlines
 * `process.env.NEXT_PUBLIC_*` only for a literal static property access. A computed lookup —
 * `process.env[name]` — is not substituted, compiles to `undefined` in the browser bundle, and
 * the override then silently never arrives in production while working in dev.
 */
const OVERRIDE_ENV = {
  earnVault: process.env.NEXT_PUBLIC_V2_EARN_VAULT,
  lenderRewardsDistributor: process.env.NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR,
  stockZap: process.env.NEXT_PUBLIC_V2_STOCK_ZAP,
} as const;

/**
 * The `v2.contracts` key each overridable key is read from in the generated `V2_CONTRACTS`. Only the lender
 * distributor is named differently: the registry calls the deployed distributor
 * `rewardsDistributorLender` (`build-markets.mjs` `V2_EXTERNAL_CONTRACT_NAMES`). That is NOT
 * `v2.protocolAddresses.distributors.lender`, the generator's exclusion list (`rewardPrograms.ts`), which is
 * never read here. `stockZap` is read from `v2.contracts.stockZap`, an external key.
 */
const REGISTRY_NAME = {
  earnVault: "earnVault",
  lenderRewardsDistributor: "rewardsDistributorLender",
  stockZap: "stockZap",
} as const satisfies Record<keyof typeof OVERRIDE_ENV, string>;

/** The variable name each key reads, for messages. Kept beside {OVERRIDE_ENV} so they cannot drift. */
const OVERRIDE_ENV_NAME = {
  earnVault: "NEXT_PUBLIC_V2_EARN_VAULT",
  lenderRewardsDistributor: "NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR",
  stockZap: "NEXT_PUBLIC_V2_STOCK_ZAP",
} as const satisfies Record<OverrideAddressKey, string>;

export type OverrideAddressKey = keyof typeof OVERRIDE_ENV;
export const OVERRIDE_ADDRESS_KEYS = Object.keys(OVERRIDE_ENV) as readonly OverrideAddressKey[];

export function isOverrideAddressKey(key: string): key is OverrideAddressKey {
  return key in OVERRIDE_ENV;
}

/** Where a resolved address came from. `null` means it resolved to nothing at all. */
export type AddressProvenance = "registry" | "override" | null;

function registryAddress(key: string): Address | null {
  return (addressKeys as readonly string[]).includes(key)
    ? (V2_DEPLOYMENT.contracts as Record<string, Address | null>)[key] ?? null
    : null;
}

/**
 * REGISTRY FIRST, OVERRIDE ONLY WHERE THE REGISTRY IS SILENT, AND ALWAYS SAY WHICH.
 *
 * A deployed registry value can never be shadowed by a stale environment variable, and an
 * override goes through the same {address} validator as everything else, so a malformed value
 * becomes `null` rather than reaching `simulateContract`. An override dropped because the registry
 * has a different value is reported by {v2AddressOverrideConflicts}, never silently.
 */
export function resolveV2Address(key: OverrideAddressKey): { address: Address | null; source: AddressProvenance } {
  // Straight from the generated `V2_CONTRACTS`, not {registryAddress}: that one only knows {addressKeys},
  // and `earnVault` / `rewardsDistributorLender` are not in it, which is how a deployed vault read as absent.
  const fromRegistry = address((rawContracts as Record<string, unknown> | null)?.[REGISTRY_NAME[key]]);
  if (fromRegistry) return { address: fromRegistry, source: "registry" };
  const fromOverride = address(OVERRIDE_ENV[key]);
  return fromOverride ? { address: fromOverride, source: "override" } : { address: null, source: null };
}

/** The address for any contract key, registry-backed or override-only. `null` = unconfigured. */
export function v2ContractAddress(key: AddressKey | OverrideAddressKey): Address | null {
  return isOverrideAddressKey(key) ? resolveV2Address(key).address : registryAddress(key);
}

/** The keys currently being served from an environment override, in {OVERRIDE_ADDRESS_KEYS} order. */
export function v2AddressOverrides(): readonly OverrideAddressKey[] {
  return OVERRIDE_ADDRESS_KEYS.filter((key) => resolveV2Address(key).source === "override");
}

/**
 * AN OVERRIDE IS NEVER SILENT — AND NEVER BLOCKING EITHER.
 *
 * This is a SEPARATE channel from {v2ConfigWarnings} by deliberate design, and the distinction is
 * load-bearing. `LendVault.tsx` `lendConfigBlockReason` and `TradeTicket.tsx` both treat a
 * non-empty warnings array as a reason to PAUSE deposits and trading. Routing "this address came
 * from an override" into that array would mean the override announces itself by disabling the
 * action it was set to enable — the vault resolves and the deposit button goes dead. So provenance
 * is an informational notice, and only a genuine disagreement with the indexer (below) blocks.
 */
export function v2AddressProvenanceNotices(): string[] {
  return v2AddressOverrides().map((key) =>
    `${key} address came from the ${OVERRIDE_ENV_NAME[key]} build-time override, not the generated registry.`);
}

/**
 * AN IGNORED OVERRIDE IS NEVER SILENT EITHER. {resolveV2Address} keeps the registry value whenever the
 * registry has one, which is right: a stale variable must not shadow a deployed address. But a variable
 * that is SET and names something else (another address, or not an address at all) is a build that
 * believes it points somewhere it does not -- during an EarnVault redeploy it is the difference between
 * "the app moved" and "the app kept the old vault". So each such key is reported here, with both values.
 *
 * Informational like {v2AddressProvenanceNotices}, and for the same reason NOT part of {v2ConfigWarnings}:
 * the registry address is the one in use and is cross-checked there; this only says the override was
 * dropped. An override equal to the registry value (any case) is redundant, not a conflict.
 */
export function v2AddressOverrideConflicts(): { key: OverrideAddressKey; env: string; registry: Address; override: string }[] {
  return OVERRIDE_ADDRESS_KEYS.flatMap((key) => {
    const resolved = resolveV2Address(key);
    const raw = OVERRIDE_ENV[key]?.trim();
    if (resolved.source !== "registry" || !resolved.address || !raw) return [];
    if (address(raw) === resolved.address) return [];
    return [{ key, env: OVERRIDE_ENV_NAME[key], registry: resolved.address, override: raw }];
  });
}

export function v2AddressOverrideConflictNotices(): string[] {
  return v2AddressOverrideConflicts().map(({ key, env, registry, override }) =>
    `${env} is set to ${address(override) ?? "a value that is not an address"}, but the generated registry records ${key} at ${registry}. `
    + `This app uses the registry address; remove or correct the override.`);
}

/** No API or fixture address is ever substituted for an unconfigured local deployment. */
export function requireV2Address(key: AddressKey | OverrideAddressKey): Address {
  const configured = v2ContractAddress(key);
  if (configured) return configured;
  throw new Error(isOverrideAddressKey(key)
    ? `V2 ${key} is not deployed in the generated registry and ${OVERRIDE_ENV_NAME[key]} is not set to a valid address`
    : `V2 ${key} is not deployed in the generated registry`);
}

/**
 * ADDRESS KEYS WHOSE INDEXER DISAGREEMENT MUST NOT PAUSE TRADING. {v2ConfigWarnings} is the
 * channel `TradeTicket.tsx`, `EarnMarket.tsx`, `LendVault.tsx` and `Portfolio.tsx` read as "pause every
 * write", and the web and the indexer deploy separately. The indexer's `/v2/config` does not send
 * `stockZap` (indexer/src/api/v2/markets.ts), so a web whose registry carries the address and compares it
 * would pause all trading against today's indexer; and the web live before this change compares the key, so it
 * pauses the moment ANY indexer starts sending it. Neither order may pause trading, so `stockZap` is judged
 * by {v2StockZapMismatch} instead, which can disable only the two Zap buttons. It stays in {addressKeys}
 * (lendTx.test.ts pins that). `earnVault` and the lender distributor are NOT here: their override
 * cross-check below keeps blocking.
 */
const NON_BLOCKING_ADDRESS_KEYS: ReadonlySet<string> = new Set(["stockZap"] satisfies AddressKey[]);

/**
 * THE ZAP-ONLY CROSS-CHECK. `null` when Zap may run; otherwise the reason the Zap buttons are
 * disabled. It compares what the indexer publishes for `stockZap` with the address this app RESOLVES
 * (registry first, then the validated override, {resolveV2Address}), because that is the address `zapTx`
 * approves and calls. An absent upstream value is not a disagreement, the same rule as the override
 * cross-check in {v2ConfigWarnings}: the indexer does not send the key today, and silence must not pause Zap.
 */
export function v2StockZapMismatch(remote: ConfigResponse): string | null {
  const upstream = address((remote.contracts as Record<string, unknown>).stockZap);
  if (!upstream) return null;
  const resolved = resolveV2Address("stockZap").address;
  if (upstream === resolved) return null;
  return resolved
    ? `Zap is paused: the indexer publishes StockZap ${upstream}, but this app would send to ${resolved}.`
    : `Zap is paused: the indexer publishes StockZap ${upstream}, but this app has no StockZap address.`;
}

/** Cross-check API boot config against the compiled registry before trusting trade quotes. */
export function v2ConfigWarnings(remote: ConfigResponse): string[] {
  const warnings: string[] = [];
  if (remote.chainId !== V2_DEPLOYMENT.chainId) warnings.push("Indexer chain differs from this app.");
  if (remote.interfaceVersion !== 8 || Number(V2_DEPLOYMENT.interfaceVersion) !== 8) warnings.push("This build requires interface version 8.");
  if (remote.interfaceVersion !== V2_DEPLOYMENT.interfaceVersion) warnings.push("Indexer interface version differs from this app.");
  if (address(remote.usdg.address) !== USDG) warnings.push("USDG address differs from this app.");
  for (const key of ["unit", "unitsPerShare", "priceTick"] as const) {
    if (String(remote.constants[key]) !== String(V2_DEPLOYMENT.constants[key]))
      warnings.push(`${key} constant differs from the app's option maths.`);
  }
  for (const key of addressKeys) {
    if (NON_BLOCKING_ADDRESS_KEYS.has(key)) continue; // judged by v2StockZapMismatch, which never pauses trading
    const local = V2_DEPLOYMENT.contracts[key];
    const upstream = address(remote.contracts[key]);
    if (local !== upstream) warnings.push(`${key} address differs from the generated registry.`);
  }
  for (const key of sourceKeys) {
    if (V2_DEPLOYMENT.sources[key] !== address(remote.contracts.sources[key]))
      warnings.push(`${key} source address differs from the generated registry.`);
  }
  // AN OVERRIDE IS STILL CROSS-CHECKED. The loop above compares the REGISTRY against the indexer
  // and must keep doing exactly that, so an override-only key is invisible to it (its registry
  // value is null on both sides). What is checked here is the case that actually means something:
  // the indexer publishes an address for a key we are serving from an override, and the two
  // disagree. That is a genuine divergence and blocking is correct. An absent upstream value is
  // NOT a disagreement — the indexer does not publish these keys at all — so it
  // must not raise a warning, or every override would pause the app.
  for (const key of OVERRIDE_ADDRESS_KEYS) {
    if (NON_BLOCKING_ADDRESS_KEYS.has(key)) continue; // stockZap's disagreement disables Zap only
    const resolved = resolveV2Address(key);
    if (resolved.source !== "override") continue;
    const upstream = address((remote.contracts as Record<string, unknown>)[key]);
    if (upstream && upstream !== resolved.address)
      warnings.push(`${key} override does not match the address the indexer publishes.`);
  }
  // Fees are mutable within contract bounds. A valid fee update must not make the
  // deployment guard disable trading; quotes use the current API/on-chain fees.
  const ladder = V2_DEPLOYMENT.defaults?.ladder as Record<"daily" | "weekly", Record<string, unknown>> | undefined;
  if (ladder) for (const tenor of ["daily", "weekly"] as const) {
    for (const [key, local] of Object.entries(ladder[tenor] ?? {})) {
      const upstream = remote.ladder[tenor][key as keyof ConfigResponse["ladder"]["daily"]];
      if (upstream !== undefined && String(local) !== String(upstream))
        warnings.push(`${tenor} ${key} default differs from the generated registry.`);
    }
  }
  return warnings;
}
