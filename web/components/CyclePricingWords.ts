import type { KeeperPricingFigures } from "@/lib/cycleTerms";

/**
 * The words components/CyclePricing.tsx puts around the keeper's pricing report, as pure functions
 * so lib-style tests can pin them (components/CyclePricingWords.test.ts). No React.
 *
 * Two rules, each once a bug:
 *   1. NO KEEPER FREE TEXT. The report's reason code for unusable market data is matched against
 *      the keeper's known codes (keeper/src/vol.ts, keeper/src/policy.ts) and printed in this
 *      file's words; an unknown code is dropped, never echoed, because runtime data does not pass
 *      scripts/copy-lint.mjs.
 *   2. NAME A SOURCE ONLY WHEN THE REPORT SAYS SO. Cboe is named only for source "cboe-delayed",
 *      and a fair value carried over from the previous listing is never called a market figure.
 */

/**
 * The feed's answer as far as this card needs it: `loading` (being asked, or not yet asked),
 * `order-finished` (Seaport reports the order sold out or cancelled, so the feed is not asked),
 * `unread` (the route is not configured, did not answer, or reported an error) and `not-served`
 * (the route answered without a row for the vault's hash).
 */
export type CyclePricingFeed = "loading" | "order-finished" | "unread" | "not-served";

const VOL_SOURCE = "cboe-delayed";

/** The keeper's reason codes for market data it could not use, in this file's words. */
export const VOL_REASON_WORDS: Readonly<Record<string, string>> = {
  "vol-unavailable": "no option chain could be fetched",
  "vol-stale": "the quotes were too old",
  "vol-inconsistent": "the quotes failed the keeper's consistency checks",
  "vol-no-expiry": "the chain had no expiry for the week",
  "vol-no-quotes": "the chain had too few usable quotes",
  "vol-strike-unquoted": "the strike was outside the quoted strikes",
  "vol-delta-out-of-range": "no quoted strike reached the target delta",
  "vol-spot-divergence": "the chain's spot was too far from the vault's spot",
};

export function isCboe(f: KeeperPricingFigures): boolean {
  return f.source === VOL_SOURCE;
}

export function modeWords(f: KeeperPricingFigures): string {
  if (f.mode === "fixed") return "fixed · strike a set distance above spot, ask at the vault floor plus margin";
  return isCboe(f)
    ? "vol · strike at a target delta on Cboe's delayed NVDA option chain"
    : "vol · strike at a target delta on a delayed NVDA option chain";
}

/** "; fresh market data was not usable (why)" for a report priced on the previous listing's fair value. */
function previousFairWords(f: KeeperPricingFigures): string {
  const code = f.volUnavailableReason;
  // Own keys only: the parser admits any lower-case code, "constructor" included.
  const why = code !== undefined && Object.hasOwn(VOL_REASON_WORDS, code) ? VOL_REASON_WORDS[code] : undefined;
  return `; fresh market data was not usable${why === undefined ? "" : ` (${why})`}`;
}

export function askWords(f: KeeperPricingFigures): string {
  const previous = f.volPath === "previous-fair";
  const fair = previous ? "the previous listing's fair value" : "the market fair value";
  switch (f.priceSource) {
    case "fill-floor":
      return f.volUnit6 !== undefined
        ? `The vault floor plus the keeper's margin, which was at or above ${fair} plus edge${previous ? previousFairWords(f) : ""}`
        : "The vault floor plus the keeper's margin";
    case "vol-fair":
      return "The market fair value plus the keeper's edge, which was above the vault floor plus margin";
    case "vol-previous-fair":
      return `The previous listing's fair value plus the keeper's edge, which was above the vault floor plus margin${previousFairWords(f)}`;
    case "manual-override":
      return f.mode === "vol"
        ? `A price the operator set, above the market-based ask${previous ? previousFairWords(f) : ""}`
        : "A price the operator set, at or above the vault floor";
  }
}

/** The muted line when no report is shown. `served`: the feed has a row for the vault's hash. */
export function unavailableWords(served: boolean, feed: CyclePricingFeed): string {
  if (served) return "The keeper sent no pricing report with this order that could be read.";
  switch (feed) {
    case "loading":
      return "Reading the keeper's pricing report…";
    case "order-finished":
      return "Seaport reports this order sold out or cancelled, so the order feed is not read and there is no pricing report to show.";
    case "unread":
      return "The order feed could not be read, so the keeper's pricing report is not shown.";
    case "not-served":
      return "The order feed is not serving the vault's order, so there is no pricing report to show.";
  }
}

/** The time row's label: Cboe's only when the report says its source is Cboe's delayed feed. */
export function chainTimeLabel(f: KeeperPricingFigures): string {
  return isCboe(f) ? "Cboe data time" : "Market data time";
}

/** The note's middle sentence: where the market figures came from. */
export function pricingSourceNote(f: KeeperPricingFigures): string {
  if (f.mode === "fixed") return "In fixed mode no market data is used.";
  if (f.volPath === "previous-fair") return "Fresh market data was not usable, so the fair value is the previous listing's, carried over.";
  return isCboe(f)
    ? "The market figures come from Cboe's delayed quotes, so they lag the market."
    : "The market figures come from delayed quotes, so they lag the market.";
}

/** The fair-value row's label: a previous listing's figure is not a current market figure. */
export function fairValueLabel(f: KeeperPricingFigures): string {
  return f.volPath === "previous-fair" ? "Previous listing's fair value per contract" : "Market fair value per contract";
}
