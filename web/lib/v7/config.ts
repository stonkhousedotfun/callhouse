import type { Address } from "viem";

/**
 * FROZEN v7 deployment mirrored from ops/markets/v7-legacy.json.
 * The JSON is excluded from the web Docker context, so runtime code must use this committed copy.
 */
export const V7_DEPLOYMENT = {
  interfaceVersion: 7,
  deployBlock: 65_780_341,
  contracts: {
    clearinghouse: "0x22dEf851cD1a3B04Ad7d232bE786d76E6944d424",
    orderBook: "0x9fcAe743C3fA0aEC7DB9b1d01e86464b85759942",
  },
} as const satisfies {
  interfaceVersion: 7;
  deployBlock: number;
  contracts: { clearinghouse: Address; orderBook: Address };
};

/** No fallback: a blank v7 URL must never read the v8 indexer. */
export function normaliseV7ApiUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

export const V7_API_URL = normaliseV7ApiUrl(process.env.NEXT_PUBLIC_V7_API_URL);
