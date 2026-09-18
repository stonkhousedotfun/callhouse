import { DEFAULT_MARKET } from "@/lib/markets";

/** Old public URLs keep a permanent destination when the v2 shell is enabled. */
export function legacyMarketPath(ticker: string, section: "account" | "book"): string {
  return `/legacy/${ticker.toLowerCase()}/${section}`;
}

export function legacyDefaultPath(section: "account" | "book"): string {
  return legacyMarketPath(DEFAULT_MARKET.ticker, section);
}

export function legacyVaultPath(suffix = ""): string {
  return `/legacy/vault/nvda${suffix}`;
}
