/**
 * W3-303. The label that renders beside a fair value saying where it came from.
 *
 * THIS COMPONENT NEVER RENDERS NOTHING. Every path returns visible text, including the one where the
 * provenance is missing entirely — that case is the whole point. X3-302 shipped the provenance
 * contract and no UI read it, so a fair value has been shown as a bare number since, which reads to
 * a buyer as a live price. While the only source is delayed vendor data, the qualifier is the honest
 * part of the figure, and a label that vanishes exactly when the data is worst would be worse than
 * having none at all.
 *
 * The wording and every branch live in `web/lib/v2/fairProvenance.ts`, which is plain TypeScript and
 * is where the behaviour is tested; this file only decides how it looks.
 */
import { fairProvenanceLabel, type FairProvenanceTone } from "@/lib/v2/fairProvenance";

const TONE: Record<FairProvenanceTone, string> = {
  neutral: "text-ink-3",
  caution: "text-ink-2",
  unknown: "text-ink-2",
};

/**
 * `provenance` is deliberately `unknown`: it comes straight off an API response and may be absent,
 * null or the wrong shape. The label function guards it and falls back rather than throwing in a
 * render.
 */
export function FairProvenanceNote({ provenance, className }: { provenance: unknown; className?: string }) {
  const label = fairProvenanceLabel(provenance);
  return (
    <span className={className ?? TONE[label.tone]} title={label.detail} data-tone={label.tone}>
      {label.text}
    </span>
  );
}

/** Re-exported so callers import one module; the logic is in lib/v2/fairProvenance.ts. */
export { fairLadderSourceSentence } from "@/lib/v2/fairProvenance";
