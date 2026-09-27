/**
 * The app's timestamp formatters, for every surface that prints a time.
 *
 * UX review item 8. The app had the same formatter written inline in six places with slightly
 * different field sets, which is how two screens come to disagree about what time an expiry is.
 * `houseEpoch.ts` already carried the comment "Same formatter as EarnMarket.tsx:39" — the bug
 * report was in the source before this rule existed.
 *
 * THE READER'S ZONE: every time includes the reader's computer or browser
 * timezone. This replaces the earlier rule that every time was New York and "not inferred per
 * client". Now:
 * - Every time a person sees is in their browser's zone, with the zone named: "Sep 24, 1:00 PM PDT"
 *   (`localStamp`), or "1:00 PM PDT" when the date is obvious (`localClock`).
 * - A market deadline (expiry, trading cutoff, settlement, a vault close or withdrawal boundary)
 *   also keeps the market's own time beside it: "Sep 24, 1:00 PM PDT (4:00 PM ET)" (`marketStamp`,
 *   `marketPair`). A reader already in New York sees it once.
 * - No separate UTC line.
 * - Every formatter here takes the zone as an argument. The browser's zone is read only in
 *   components/ui/Time.tsx, after mount. A server render cannot know the reader's zone (on Railway
 *   it would print UTC), so the server renders New York, zone named, and the client switches to the
 *   reader's zone once mounted. Server-rendered images (OG/PnL) keep New York: `stamp`/`dayStamp`.
 * - Never a time with no zone name, and never a hard-coded "EDT"/"PDT": Intl names the zone in
 *   force at that instant.
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
// already render (measured four of them at "Sep 21, 2026, 4:00 PM EDT").
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

/** "Sep 21, 2026, 4:00 PM EDT" — a moment in New York, for server-rendered images and text. Names its zone. */
export function stamp(unixSeconds: number): string {
  return DATE_AND_TIME.format(toDate(unixSeconds));
}

/** "Sep 21, 2026" — a day, where the time of day is noise rather than information. */
export function dayStamp(unixSeconds: number): string {
  return DATE_ONLY.format(toDate(unixSeconds));
}

// One formatter per (shape, zone), built on first use: the reader's zone is known only at run time.
const ZONED_SHAPES = {
  moment: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  clock: { hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  day: { month: "short", day: "numeric", year: "numeric" },
  bareDay: { month: "short", day: "numeric" },
  bareClock: { hour: "numeric", minute: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;
const zoned = new Map<string, Intl.DateTimeFormat>();

function zonedFormat(shape: keyof typeof ZONED_SHAPES, timeZone: string, unixSeconds: number): string {
  const key = `${shape}|${timeZone}`;
  let fmt = zoned.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { ...ZONED_SHAPES[shape], timeZone });
    zoned.set(key, fmt);
  }
  return fmt.format(toDate(unixSeconds));
}

/** "Sep 24, 1:00 PM PDT" — a moment in the given IANA zone, zone named. */
export function localStamp(unixSeconds: number, timeZone: string): string {
  return zonedFormat("moment", timeZone, unixSeconds);
}

/** "1:00 PM PDT" — a moment whose date is obvious from context, zone named. */
export function localClock(unixSeconds: number, timeZone: string): string {
  return zonedFormat("clock", timeZone, unixSeconds);
}

/** "Sep 24, 2026" — the day in the given zone. No zone name, for the reason `dayStamp` gives. */
export function localDayStamp(unixSeconds: number, timeZone: string): string {
  return zonedFormat("day", timeZone, unixSeconds);
}

/** "4:00 PM ET", or "Sep 24, 4:00 PM ET" when New York's day differs from the reader's. */
function marketSuffix(unixSeconds: number, timeZone: string): string {
  const clock = `${zonedFormat("bareClock", NEW_YORK_TIME_ZONE, unixSeconds)} ET`;
  const sameDay = zonedFormat("bareDay", timeZone, unixSeconds) === zonedFormat("bareDay", NEW_YORK_TIME_ZONE, unixSeconds);
  return sameDay ? clock : `${zonedFormat("bareDay", NEW_YORK_TIME_ZONE, unixSeconds)}, ${clock}`;
}

/**
 * "Sep 24, 1:00 PM PDT (4:00 PM ET)" — a market deadline in the reader's zone with the market time beside it.
 * "Sep 24, 4:00 PM EDT" once when the reader's zone already reads as New York.
 */
export function marketStamp(unixSeconds: number, timeZone: string): string {
  const local = localStamp(unixSeconds, timeZone);
  if (local === localStamp(unixSeconds, NEW_YORK_TIME_ZONE)) return local;
  return `${local} (${marketSuffix(unixSeconds, timeZone)})`;
}

/** "1:00 PM PDT (4:00 PM ET)" — `marketStamp` without the reader's date, for when the date is obvious. */
export function marketPair(unixSeconds: number, timeZone: string): string {
  const local = localClock(unixSeconds, timeZone);
  if (localStamp(unixSeconds, timeZone) === localStamp(unixSeconds, NEW_YORK_TIME_ZONE)) return local;
  return `${local} (${marketSuffix(unixSeconds, timeZone)})`;
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

/**
 * "42s", "8m", "15h", "2d" -- how long ago something was read, in its largest whole unit.
 *
 * The market page's spot age formatted only seconds and minutes, so a reading 15.5 hours old said "930m ago". Seconds
 * in, like everything here; a negative age (a clock a little ahead of the indexer) reads as 0s, not as the future.
 */
export function ageText(seconds: number): string {
  if (!Number.isFinite(seconds)) throw new RangeError("ages are seconds");
  const age = Math.max(0, Math.trunc(seconds));
  if (age < 60) return `${age}s`;
  if (age < 3_600) return `${Math.floor(age / 60)}m`;
  if (age < 86_400) return `${Math.floor(age / 3_600)}h`;
  return `${Math.floor(age / 86_400)}d`;
}
