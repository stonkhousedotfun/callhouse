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
] as const satisfies readonly AddressKey[];
const sourceKeys = ["chainlink", "univ3", "dataStreams"] as const;

export const V2_DEPLOYMENT = {
  chainId: Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 4663),
  interfaceVersion: generated.V2_REGISTRY.interfaceVersion,
  contracts: Object.fromEntries(addressKeys.map((key) => [key, address(rawContracts?.[key])])) as Record<AddressKey, Address | null>,
  sources: Object.fromEntries(sourceKeys.map((key) => [key, address(rawContracts?.sources?.[key])])) as Record<(typeof sourceKeys)[number], Address | null>,
  fees: (value("V2_FEES") ?? null) as Record<string, unknown> | null,
  defaults: (value("V2_DEFAULTS") ?? null) as Record<string, unknown> | null,
  constants: { unit: UNIT.toString(), unitsPerShare: Number(UNITS_PER_SHARE), priceTick: Number(PRICE_TICK) },
} as const;

/** No API or fixture address is ever substituted for an unconfigured local deployment. */
export function requireV2Address(key: AddressKey): Address {
  const configured = V2_DEPLOYMENT.contracts[key];
  if (!configured) throw new Error(`V2 ${key} is not deployed in the generated registry`);
  return configured;
}

/** Cross-check API boot config against the compiled registry before trusting trade quotes. */
export function v2ConfigWarnings(remote: ConfigResponse): string[] {
  const warnings: string[] = [];
  if (remote.chainId !== V2_DEPLOYMENT.chainId) warnings.push("Indexer chain differs from this app.");
  if (remote.interfaceVersion !== 7 || Number(V2_DEPLOYMENT.interfaceVersion) !== 7) warnings.push("This build requires interface version 7.");
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
