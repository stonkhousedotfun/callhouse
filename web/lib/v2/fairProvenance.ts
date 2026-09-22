/**
 * W3-303. Turns a fair value's provenance into the label shown beside it. No React, no API, no chain.
 *
 * WHY THIS EXISTS AT ALL. X3-302 shipped the whole provenance CONTRACT — `pricingProvenanceSchema`
 * (`api-schema.ts:120`), the entitlement class enum at `:211`, `fairProvenance` at `:368` and a
 * fail-closed refinement at `:372-374` — and it is asserted by schema twins and type tests. But
 * `grep -rn 'rovenance' web/components/ web/app/` returned NOTHING at this base: no UI read any of
 * it. That is the false-green shape in its purest form — deleting every consumer of the provenance
 * contract would have changed nothing, because there were none. The assertions passed on a field the
 * product never showed anyone.
 *
 * THE RULE THAT DECIDES EVERY BRANCH BELOW: ABSENCE IS NOT REAL-TIME. A missing, null or malformed
 * provenance renders as "Data source unknown", never as silence and never as a real-time claim. This
 * is a compliance surface — while the only source is delayed vendor data, showing a bare number with
 * no qualifier tells the reader it is live. A label that disappears when the data is worst is the
 * failure this module is written to prevent, so every path returns a label and the fallback is the
 * most conservative one.
 */
import type { PricingProvenance } from "./api-types";

export type FairProvenanceTone = "neutral" | "caution" | "unknown";

export type FairProvenanceLabel = {
  /** The short badge text, always non-empty. */
  text: string;
  /** Longer sentence for a title/tooltip. Always non-empty. */
  detail: string;
  tone: FairProvenanceTone;
  /** True only when the feed is entitled real-time AND the reading is ready. */
  isLive: boolean;
};

/** The conservative answer, used whenever provenance is absent or unreadable. */
export const UNKNOWN_SOURCE_LABEL = "Data source unknown";

const UNKNOWN: FairProvenanceLabel = {
  text: UNKNOWN_SOURCE_LABEL,
  detail: "This figure's data source was not reported, so it may lag the market. Treat it as indicative.",
  tone: "unknown",
  isLive: false,
};

/** Whole minutes, rounded down; under a minute reads as "less than a minute". */
function ageText(seconds: number): string {
  if (seconds < 60) return "less than a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * A declared delay is the vendor's entitlement, not an observation, so it is stated as "delayed by
 * N", while an age is stated as "as of N ago". Conflating them would let a 15-minute entitlement
 * describe a two-hour-old quote.
 */
function delayText(declaredDelayS: number | null): string | null {
  return declaredDelayS !== null && declaredDelayS > 0 ? ageText(declaredDelayS) : null;
}

function isProvenance(value: unknown): value is PricingProvenance {
  if (!value || typeof value !== "object") return false;
  const entitlement = (value as { entitlement?: unknown }).entitlement;
  return Boolean(entitlement) && typeof entitlement === "object"
    && typeof (entitlement as { class?: unknown }).class === "string";
}

/**
 * The label for one fair value.
 *
 * Takes `unknown` rather than the narrowed type on purpose: this is fed by an API response, and a
 * payload that does not match the type must still produce a label rather than throwing inside a
 * render. {isProvenance} is the guard, and its failure path is {UNKNOWN}, not an exception.
 */
export function fairProvenanceLabel(provenance: unknown): FairProvenanceLabel {
  if (!isProvenance(provenance)) return UNKNOWN;

  const { entitlement, quality, ages } = provenance;
  const readiness = quality?.readiness ?? "unavailable";
  const delay = delayText(entitlement.declaredDelayS ?? null);
  const quoteAge = typeof ages?.quoteS === "number" && ages.quoteS >= 0 ? ageText(ages.quoteS) : null;
  const asOf = quoteAge ? ` Quote observed ${quoteAge} ago.` : "";

  // Readiness outranks entitlement. A real-time feed that is not ready is not live, and saying
  // "real-time" over a degraded reading is the most misleading thing this component could do.
  if (readiness === "unavailable") {
    return { text: "Source unavailable", tone: "unknown", isLive: false,
      detail: `This figure's pricing source is unavailable, so it may be stale or wrong.${asOf}` };
  }

  switch (entitlement.class) {
    case "real-time":
      return readiness === "ready"
        ? { text: "Real-time data", tone: "neutral", isLive: true,
            detail: `Priced from real-time market data.${asOf}` }
        : { text: "Real-time data, degraded", tone: "caution", isLive: false,
            detail: `The feed is real-time but this reading is degraded, so it may lag the market.${asOf}` };
    case "delayed":
      return { text: delay ? `Delayed data (${delay})` : "Delayed data", tone: "caution", isLive: false,
        detail: delay
          ? `The market figures come from delayed quotes, delayed by ${delay}, so they lag the market.${asOf}`
          : `The market figures come from delayed quotes, so they lag the market.${asOf}` };
    case "end-of-day":
      return { text: "End-of-day data", tone: "caution", isLive: false,
        detail: `Priced from end-of-day data, not live quotes, so it does not reflect today's market.${asOf}` };
    case "indicative":
      return { text: "Indicative data", tone: "caution", isLive: false,
        detail: `This figure is indicative, not a tradable quote.${asOf}` };
    case "unknown":
    default:
      // Includes any class the enum grows that this build has never heard of. A new entitlement
      // class must read as unknown, not fall through to a friendlier label.
      return { ...UNKNOWN, detail: `${UNKNOWN.detail}${asOf}` };
  }
}

/** True when a fair value may be shown without a qualifier. Nothing today should rely on this. */
export function fairIsLive(provenance: unknown): boolean {
  return fairProvenanceLabel(provenance).isLive;
}

/**
 * The ladder's source, as one sentence for a table footnote.
 *
 * A strike ladder is many quotes, so the label has to describe the SET. Identical labels collapse to
 * one; anything else says so explicitly rather than picking the friendliest of them, because "some of
 * these rows are delayed" is the fact a reader needs and the most optimistic row is the one that
 * would mislead. An EMPTY ladder is unknown too — no rows is not evidence of a live source.
 */
export function fairLadderSourceSentence(quotes: readonly { fairProvenance?: unknown }[]): string {
  const labels = quotes.map((quote) => fairProvenanceLabel(quote.fairProvenance));
  if (labels.length === 0) return UNKNOWN.detail;
  const texts = new Set(labels.map((label) => label.text));
  if (texts.size === 1) return labels[0]!.detail;
  return `These rows do not share one data source (${[...texts].sort().join("; ")}), so treat the ladder as delayed.`;
}
