/**
 * One page per House vault.
 *
 * A market holds two House vaults once the daily vaults are live (one weekly, one daily; HouseVaultFactory allows one
 * per (stock, cadence)). GET /v2/house/:market used to serve whichever of them the database returned first, and the
 * /house/<ticker> page had no way to ask for the other, so a weekly depositor told to withdraw could land on the daily
 * vault's page with no path back to their own. The indexer now takes `?vault=<address>`, and so does the page.
 *
 * This file holds the page's pure pieces: reading the `vault` search parameter, the link to one vault, the other vaults
 * of the same market, the check that the indexer answered for the vault that was asked for, and their copy.
 */
import { isAddress } from "viem";

import type { HouseVault } from "./api-types";

/**
 * The `vault` search parameter, or undefined. A value that fails viem `isAddress` (strict, the default: lowercase or a
 * correct EIP-55 checksum) is ignored rather than an error, so the page falls back to the market's default vault. A
 * repeated parameter (an array) is ignored the same way.
 */
export function parseVaultParam(raw: unknown): string | undefined {
  return typeof raw === "string" && isAddress(raw) ? raw : undefined;
}

/** The page for one exact vault of a market. */
export function houseVaultHref(ticker: string, vault: string): string {
  return `/house/${ticker.toLowerCase()}?vault=${vault}`;
}

/**
 * True when a vault was asked for and the response names a different one (compared lowercased). An indexer deployed
 * before ignores `?vault=` and still answers with its first vault, so without this a new page talking to an
 * old indexer would send a deposit to a vault the user did not pick. Nothing asked for, or nothing answered yet: false.
 */
export function houseVaultMismatch(requested: string | undefined, served: string | null | undefined): boolean {
  if (requested === undefined || served === undefined || served === null) return false;
  return requested.toLowerCase() !== served.toLowerCase();
}

/**
 * The other vaults of this market, from the /v2/house list: same market (ignoring case), a vault address present, and
 * not the vault being shown. List order is kept (the indexer's: daily first).
 */
export function houseSiblings(items: readonly HouseVault[], ticker: string, shown: string | null | undefined): HouseVault[] {
  const market = ticker.toLowerCase();
  const self = shown?.toLowerCase() ?? null;
  return items.filter((item) => item.market.toLowerCase() === market && item.vault !== null
    && item.vault.toLowerCase() !== self);
}

/** Heading over the links to a market's other vaults. */
export function houseSiblingsHeading(ticker: string): string {
  return `Other ${ticker} house vaults`;
}

/**
 * Marks a sibling link to a weekly vault that is winding down. Deliberately a different phrase from the page's own
 * wind-down headline: that headline says THIS page's vault is closing, and a daily vault's page that links to a closing
 * weekly vault must not read as closing itself.
 */
export const HOUSE_SIBLING_CLOSED = "closed to new deposits";

/** Shown when the indexer answered for a different vault from the one in the link. Every write is disabled. */
export const HOUSE_VAULT_MISMATCH =
  "The figures below are for a different vault from the one in this link, so this page will not send any transaction. Open the vault again from the list of house vaults.";

/** Shown when a vault was asked for and could not be read (the indexer answered 404 or failed). */
export function houseVaultUnavailable(ticker: string): string {
  return `The ${ticker} house vault in this link could not be loaded.`;
}
