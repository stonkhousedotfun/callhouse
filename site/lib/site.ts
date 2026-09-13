/**
 * The one place this package knows a URL, a ticker or an address.
 *
 * Two domains, one product: callhouse.xyz is this package (static marketing, zero wallet code)
 * and app.callhouse.xyz is @callhouse/web (the dapp). Nothing here is same-origin with the app,
 * so every "go do something" link must be an absolute external URL built with appUrl() — a bare
 * href="/vault/nvda" on this site is a 404 on callhouse.xyz, not a route into the dapp.
 *
 * The constants below are DUPLICATED FROM web/lib/contracts.ts, web/lib/chain.ts and README.md
 * ON PURPOSE. site/ must build, typecheck and deploy with no dependency on web/ — it is a second
 * Railway service with its own container, and a shared package would drag viem (and therefore a
 * wallet-shaped dependency tree) into a landing page that makes no chain calls at all. This file
 * DISPLAYS these addresses; it never calls them. If an address changes, README.md and
 * ops/addresses.json are the source of truth and this file is updated by hand to match.
 *
 * Deliberately absent: chain clients, ABIs, a vault address (the vault is not deployed, and a
 * placeholder would be worse than not showing one), and anything that reads live state. Every
 * number on this site is a fixed policy parameter, not a quote.
 */

/** Strip trailing slashes so joins never produce `//`. */
function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** This site. Used for canonical URLs and metadataBase. */
export const SITE_URL = normalizeBase(process.env.NEXT_PUBLIC_SITE_URL ?? "https://callhouse.xyz");

/** The dapp. Every CTA on this site points into it. */
export const APP_URL = normalizeBase(process.env.NEXT_PUBLIC_APP_URL ?? "https://app.callhouse.xyz");

/**
 * Join a dapp route onto APP_URL. `appUrl("/vault/nvda")` and `appUrl("vault/nvda")` both give
 * `https://app.callhouse.xyz/vault/nvda`, and `appUrl()` gives the bare origin with no trailing
 * slash. An absolute URL is passed through untouched so callers can hand this any href.
 */
export function appUrl(path = ""): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  const rest = path.replace(/^\/+/, "");
  return rest ? `${APP_URL}/${rest}` : APP_URL;
}

/** First (and at launch, only) market. Matches MARKET / SHARE_TICKER in web/lib/contracts.ts. */
export const MARKET = "NVDA";
export const SHARE_TICKER = "cNVDA";

/** Robinhood Chain mainnet, an Arbitrum Orbit L2. 4663 = 0x1237. */
export const CHAIN_ID = 4663;
export const CHAIN_NAME = "Robinhood Chain";

/**
 * Blockscout is the canonical explorer. Links only: its API sits behind a Cloudflare JS
 * challenge, and in any case nothing on this site fetches anything.
 */
export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

/** Where the weekly cycle actually happens. Third party, not ours. */
export const VENUE_NAME = "Overcall";
export const VENUE_URL = "https://overcall.finance";

export type AddressRow = {
  /** Label as it appears in the README addresses table. */
  label: string;
  /** Checksummed, as confirmed on chain 4663 by ops/recon/. */
  address: string;
  /** One line on what it does, for the table's second column. */
  what: string;
};

/**
 * The contracts a reader can verify before depositing anything. All third-party: the Callhouse
 * vault is NOT listed because it is not deployed yet, and the fee Safe is an ops detail, not a
 * public integration point. Insertion order is display order.
 */
export const ADDRESSES = {
  clear: {
    label: "Valorem Clear",
    address: "0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0",
    what: "Writes the calls and holds the collateral until expiry or exercise.",
  },
  seaport: {
    label: "Seaport 1.6",
    address: "0x0000000000000068F116a894984e2DB1123eB395",
    what: "Matches the listing. The vault is the offerer; a buyer fills or nobody does.",
  },
  usdg: {
    label: "USDG",
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    what: "6 decimals. Every premium, strike and claim is denominated in it.",
  },
  asset: {
    label: `${MARKET} Stock Token`,
    address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    what: "18 decimals. The collateral, and a debt security issued by Robinhood Assets (Jersey) Limited.",
  },
  registry: {
    label: `${VENUE_NAME} ${MARKET} registry`,
    address: "0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA",
    what: "Defines the weekly cycle and the strike rungs. One registry per market; this one is NVDA's.",
  },
  priceFeed: {
    label: "Chainlink RHNVDA / USD",
    address: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
    what: "8 decimals. Display and the write gate only. Settlement never reads a price feed.",
  },
} as const satisfies Record<string, AddressRow>;

/** Same rows, ordered, for rendering a table without Object.values() at the call site. */
export const ADDRESS_ROWS: readonly AddressRow[] = Object.values(ADDRESSES);

/** Explorer link for one of the addresses above. */
export function addressUrl(address: string): string {
  return `${EXPLORER_URL}/address/${address}`;
}
