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
 * key set in two languages, and F3 was exactly the case where they disagreed and nothing noticed:
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
 * OVERRIDE-ONLY ADDRESS KEYS — design B, coordinator ruling on Q-d90a811aa2cb4e27, rule 2 at
 * `stonkhouse-plan/.../02-interfaces.md:584-590`.
 *
 * These three contracts have NO key in the generated registry and this change adds none:
 * `web/scripts/gen-markets.mjs` `V2_CONTRACT_NAMES` and `ops/markets/build-markets.mjs`
 * `V2_CONTRACT_NAMES` both keep their existing eleven names, and `api-schema.ts` `contracts`
 * gains nothing. They resolve from a validated `NEXT_PUBLIC_*` override or they are
 * unconfigured — never a literal null constant at the call site.
 *
 * `stockZap` is the odd member. It is already in {addressKeys} below and already
 * `.optional()` in `api-schema.ts` `contracts`, but no registry can fill it (its name is not in
 * either `V2_CONTRACT_NAMES`, and `assertExactKeys` rejects an unknown key), so in practice it is
 * override-only too. It is deliberately NOT removed from {addressKeys}: it is wired to live code
 * (`zapTx.ts:111,120`, `EarnMarket.tsx`), and deleting the key turns a dead feature into a
 * compile error at best and a silently absent one at worst.
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
 * becomes `null` rather than reaching `simulateContract`.
 */
export function resolveV2Address(key: OverrideAddressKey): { address: Address | null; source: AddressProvenance } {
  const fromRegistry = registryAddress(key);
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

/** No API or fixture address is ever substituted for an unconfigured local deployment. */
export function requireV2Address(key: AddressKey | OverrideAddressKey): Address {
  const configured = v2ContractAddress(key);
  if (configured) return configured;
  throw new Error(isOverrideAddressKey(key)
    ? `V2 ${key} is not deployed in the generated registry and ${OVERRIDE_ENV_NAME[key]} is not set to a valid address`
    : `V2 ${key} is not deployed in the generated registry`);
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
  // NOT a disagreement — the indexer does not publish these keys at all under design B — so it
  // must not raise a warning, or every override would pause the app.
  for (const key of OVERRIDE_ADDRESS_KEYS) {
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
