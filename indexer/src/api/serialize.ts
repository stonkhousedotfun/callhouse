import { formatUnits } from "viem";

import { ASSET_DECIMALS, USDG_DECIMALS } from "../../lib/env";

/**
 * JSON cannot carry a bigint, and a uint256 cannot survive `Number`. Every integer that
 * crosses this API is therefore a DECIMAL STRING in base units — the same convention
 * Overcall's own API uses for uint values.
 */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function toJson(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(toJson);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJson(v);
    }
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  return String(value);
}

/** A money figure in one place: base units for maths, a decimal string for display. */
export type Amount = { raw: string; decimals: number; formatted: string };

const amount = (v: bigint | null | undefined, decimals: number): Amount => {
  const n = v ?? 0n;
  return { raw: n.toString(), decimals, formatted: formatUnits(n, decimals) };
};

/** USDG is 6 decimals. Premium, strikes and every fee are quoted in it. */
export const usdg = (v: bigint | null | undefined): Amount => amount(v, USDG_DECIMALS);

/** The Stock Token — and therefore the vault's shares — is 18 decimals. */
export const asset = (v: bigint | null | undefined): Amount => amount(v, ASSET_DECIMALS);

/** Unix seconds → ISO 8601, or null. Timestamps on chain are uint40 seconds. */
export const iso = (secs: bigint | number | null | undefined): string | null => {
  if (secs === null || secs === undefined) return null;
  const n = Number(secs);
  if (!Number.isFinite(n) || n === 0) return null;
  return new Date(n * 1000).toISOString();
};

export const num = (v: bigint | null | undefined): string => (v ?? 0n).toString();
