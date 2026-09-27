import { Chip, type ChipTone } from "./Chip";

/**
 * A market's or a vault's status, in the four words the Neon screens use: Live,
 * Coming soon, Paused, Deferred. A Chip with its dot, so the colour is never the only signal: the word is always
 * there, and the dot only repeats it.
 *
 *   live      accent  (--accent-soft / --accent-text, the spec's "Live" pill)
 *   soon      warn    (--warn, "Opens soon")
 *   paused    warn    (--warn, "paused")
 *   deferred  neutral (not on the launch set; nothing to act on)
 *
 * Coming soon and Paused share a tone on purpose: both mean "not tradeable right now, but it will be"; the word says
 * which. The vocabulary is closed so the Market status filters (All, Live, Coming soon, Paused, Deferred) and the
 * pills on the cards cannot drift apart.
 */
export type MarketStatus = "live" | "soon" | "paused" | "deferred";

export const STATUS_LABEL: Readonly<Record<MarketStatus, string>> = {
  live: "Live",
  soon: "Coming soon",
  paused: "Paused",
  deferred: "Deferred",
};

const TONE: Readonly<Record<MarketStatus, ChipTone>> = {
  live: "accent",
  soon: "warn",
  paused: "warn",
  deferred: "neutral",
};

export function StatusPill({ status, className }: { status: MarketStatus; className?: string }) {
  return (
    <Chip tone={TONE[status]} dot data-slot="status-pill" data-status={status} className={className}>
      {STATUS_LABEL[status]}
    </Chip>
  );
}
