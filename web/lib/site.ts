/**
 * The two domains this product is served from.
 *
 * stonkhouse.fun         — the marketing surface (repo leekzor/callhouse-site). Static, no wallet code.
 * app.stonkhouse.fun     — this package. The dapp, every route unchanged.
 *
 * These exist for exactly two reasons: so the app can link back to the marketing site, and so
 * Next has an absolute base for metadata (`metadataBase`, canonical URLs, Open Graph). NOTHING
 * here is used for chain access — RPCs, the explorer and every contract address live in
 * lib/chain.ts and lib/contracts.ts, and no code path should ever reach for a URL from this
 * file to talk to a node.
 *
 * Both are NEXT_PUBLIC_*, so both are inlined at BUILD time. Both have production defaults
 * compiled in: a missing env var must not produce a relative-URL metadata base or a link to
 * `undefined`. Overriding them is for previews and local work, not for filling in a blank.
 */

function clean(value: string | undefined, fallback: string): string {
  const raw = value?.trim();
  // Trailing slashes are stripped so `${SITE_URL}/risks` never renders a doubled slash.
  return (raw && raw.length > 0 ? raw : fallback).replace(/\/+$/, "");
}

/** Marketing site. Landing, /how-it-works, /risks, /legal, /terms, /privacy. Canonical for the disclosures. */
export const SITE_URL = clean(process.env.NEXT_PUBLIC_SITE_URL, "https://stonkhouse.fun");

/** The full documentation (GitBook, synced from leekzor/callhouse-docs). Linked from the footer. */
export const DOCS_URL = clean(process.env.NEXT_PUBLIC_DOCS_URL, "https://docs.stonkhouse.fun");

/** This app. Used as the metadata base; the dapp is reached by link from SITE_URL. */
export const APP_URL = clean(process.env.NEXT_PUBLIC_APP_URL, "https://app.stonkhouse.fun");

/**
 * Public product status. Same strings as leekzor/callhouse-site `lib/site.ts`, so the two domains
 * cannot disagree on whether we are in beta or whether an audit has landed.
 */
export const STATUS = {
  phase: "Beta",
  audit: "Pending audit",
  auditLine: "The Stonkhouse contracts have not been audited. An external audit is pending.",
} as const;

/**
 * The two legal documents. They live on the marketing site ONLY and are linked from here, not
 * duplicated: this domain is noindex, the disclosures get one address, and the operator facts
 * they render (entity, governing law, contact) are build-time constants of the landing
 * (leekzor/callhouse-site), not of this package. A copy here would be a second version to keep
 * in sync and would drift on the day counsel fills the site's in. Both are absolute,
 * cross-origin, and open in a new tab.
 */
export const TERMS_URL = `${SITE_URL}/terms`;
export const PRIVACY_URL = `${SITE_URL}/privacy`;
