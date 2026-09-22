/**
 * One America/New_York formatter set, for every surface that prints a timestamp.
 *
 * UX review item 8. The app had the same formatter written inline in six places with slightly
 * different field sets, which is how two screens come to disagree about what time an expiry is.
 * `houseEpoch.ts` already carried the comment "Same formatter as EarnMarket.tsx:39" — the bug
 * report was in the source before this row existed.
 *
 * WHY NEW YORK IS NOT A PARAMETER. Every timestamp this app prints is an options-market time:
 * expiries, cutoffs, settlement and epoch boundaries all follow the US equity session. Rendering
 * one of them in the reader's local zone would put a 4pm ET cutoff at 21:00 for a London reader
 * with no indication of which zone the number is in, and a cutoff read in the wrong zone is a
 * missed trade. The zone is therefore fixed here and named in the output, not inferred per client.
 *
 * SECONDS IN, NEVER MILLISECONDS. Every caller has unix seconds because that is what the v2 wire
 * carries (`api-schema.ts`), and a helper that silently accepted both would mis-render by a
 * factor of a thousand rather than throwing — the same class of bug as a wrong decimals value.
 */
export const NEW_YORK_TIME_ZONE = "America/New_York";

// `timeZoneName: "short"` is what makes the paragraph above true rather than aspirational: without
// it this renders "Sep 21, 2026, 4:00 PM", which names no zone at all and is exactly the number a
// London reader misreads. It cannot be combined with `dateStyle`/`timeStyle` — Intl rejects that
// pairing — so the fields are spelled out, and they are spelled to match what the shipped surfaces
// already render (T-460 measured four of them at "Sep 21, 2026, 4:00 PM EDT").
const DATE_AND_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit",
  timeZone: NEW_YORK_TIME_ZONE, timeZoneName: "short",
});
const DATE_ONLY = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: NEW_YORK_TIME_ZONE,
});

function toDate(unixSeconds: number): Date {
  if (!Number.isFinite(unixSeconds)) throw new RangeError("timestamps are unix seconds");
  return new Date(unixSeconds * 1000);
}

/** "Sep 21, 2026, 4:00 PM EDT" — a moment, for an expiry, a cutoff or a roll. Names its zone. */
export function stamp(unixSeconds: number): string {
  return DATE_AND_TIME.format(toDate(unixSeconds));
}

/** "Sep 21, 2026" — a day, where the time of day is noise rather than information. */
export function dayStamp(unixSeconds: number): string {
  return DATE_ONLY.format(toDate(unixSeconds));
}

/**
 * "2d 4h", "3h 12m", "8m", "now" — time remaining, for a deadline the reader is acting against.
 *
 * Returns "now" rather than a negative or a zero, because a countdown that has run out is a state
 * ("this is closing") and not a measurement, and a bare "0m" reads as a rendering fault.
 */
export function countdown(untilUnixSeconds: number, nowUnixSeconds: number): string {
  if (!Number.isFinite(untilUnixSeconds) || !Number.isFinite(nowUnixSeconds)) {
    throw new RangeError("timestamps are unix seconds");
  }
  const remaining = Math.trunc(untilUnixSeconds) - Math.trunc(nowUnixSeconds);
  if (remaining <= 0) return "now";
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
