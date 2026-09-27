/**
 * The day picker's options (Neon design).
 *
 * THE RULES:
 *   - Only listed expiries. The picker is built from the expiries the caller actually has (series on the book,
 *     quotes on the wire); it never invents a calendar. A day with nothing listed is not a chip, so there is no
 *     chip that leads to an empty table.
 *   - At most six. NVDA's launch expiries are daily, up to about six days ahead; SPCX's are its
 *     Friday closes only, which fall on days NVDA lists too. If more are listed the nearest six win.
 *   - Expired ones are dropped: an expiry at or before `now` cannot be bought.
 *   - Labels: "Today", then "Wed 23", "Thu 24". The phone uses short weekday tabs: "Today", "Wed", "Thu".
 *   - No two chips on different New York days read the same. Six expiries can span more than a week,
 *     and then a weekday repeats: the phone read "Today · Thu · Fri · Fri". A short tab whose weekday another listed
 *     day also has takes the day's full label ("Fri 25", "Fri 2"); tabs that do not collide keep the weekday alone.
 *     A full label that still collides (the same weekday and date a month or more apart) adds the month.
 *
 * WHICH DAY IS "TODAY". The New York calendar day, not the reader's. Expiries are options-market times
 * (lib/v2/time.ts explains why the zone is fixed), so a 4pm ET expiry read at 23:00 in London on the same ET day
 * is still "Today". Two listed expiries on one New York day keep separate values but would share a label; the
 * `long` form carries the time so a reader can still tell them apart.
 *
 * SECONDS IN, like every other helper on the v2 wire.
 */
import { marketStamp, NEW_YORK_TIME_ZONE, stamp } from "@/lib/v2/time";

export const DAY_PICKER_MAX = 6;

export type DayOption = {
  /** The expiry, unix seconds, as given. The picker's value. */
  expiry: number;
  /** "Today" or "Wed 23". */
  label: string;
  /** "Today" or "Wed": the phone's weekday tabs. "Fri 25" when another listed day is also a Friday. */
  short: string;
  /** "Sep 23, 2026, 4:00 PM EDT": the accessible name and hover text. */
  long: string;
  /**
   * Present, and true, only for a day past its mint cutoff: no new option can be written, but
   * resale asks and bids trade until expiry. `long` then says so. Absent on every other day.
   */
  resaleOnly?: true;
};

/** Appended to `long` on a resale-only day. */
export const RESALE_ONLY_NOTE = "resale asks and bids only";

const PARTS = new Intl.DateTimeFormat("en-US", {
  weekday: "short", day: "numeric", year: "numeric", month: "numeric", timeZone: NEW_YORK_TIME_ZONE,
});
const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: NEW_YORK_TIME_ZONE });

type NyDay = { key: string; weekday: string; day: string; month: string };

function nyDay(unixSeconds: number): NyDay {
  if (!Number.isFinite(unixSeconds)) throw new RangeError("timestamps are unix seconds");
  const at = new Date(unixSeconds * 1000);
  const bag: Record<string, string> = {};
  for (const part of PARTS.formatToParts(at)) bag[part.type] = part.value;
  return { key: `${bag.year}-${bag.month}-${bag.day}`, weekday: bag.weekday ?? "", day: bag.day ?? "", month: MONTH.format(at) };
}

/** True when a chip on a DIFFERENT New York day would show the same text. Same-day chips share text by design. */
function collides(days: readonly NyDay[], day: NyDay, text: (d: NyDay) => string): boolean {
  return days.some((other) => other.key !== day.key && text(other) === text(day));
}

/**
 * The chips for `expiries` as seen at `now` (both unix seconds): future only, deduplicated, ascending, nearest
 * {DAY_PICKER_MAX}. A day also in `resaleOnly` (past its mint cutoff) is marked, not dropped.
 * Chips are New York market days. `timeZone` is the reader's zone for `long`, "Sep 24, 1:00 PM PDT
 * (4:00 PM ET)"; omitted, `long` stays the New York stamp.
 */
export function dayOptions(expiries: readonly number[], now: number, max: number = DAY_PICKER_MAX,
  resaleOnly: readonly number[] = [], timeZone?: string): DayOption[] {
  const resale = new Set(resaleOnly);
  return baseDayOptions(expiries, now, max, timeZone).map((option) => resale.has(option.expiry)
    ? { ...option, long: `${option.long} · ${RESALE_ONLY_NOTE}`, resaleOnly: true as const }
    : option);
}

function baseDayOptions(expiries: readonly number[], now: number, max: number, timeZone: string | undefined): DayOption[] {
  const long = (expiry: number) => (timeZone === undefined ? stamp(expiry) : marketStamp(expiry, timeZone));
  const today = nyDay(now).key;
  const listed = [...new Set(expiries)]
    .filter((expiry) => Number.isFinite(expiry) && expiry > now)
    .sort((a, b) => a - b)
    .slice(0, Math.max(0, max));
  const days = listed.map(nyDay);
  // "Today" is the only chip that shows no weekday or date, so only the other days can collide with each other.
  const dated = days.filter((day) => day.key !== today);
  const dateLabel = (d: NyDay) => `${d.weekday} ${d.day}`;
  return listed.map((expiry, index) => {
    const day = days[index]!;
    if (day.key === today) return { expiry, label: "Today", short: "Today", long: long(expiry) };
    const label = collides(dated, day, dateLabel) ? `${day.weekday} ${day.month} ${day.day}` : dateLabel(day);
    return {
      expiry,
      label,
      short: collides(dated, day, (d) => d.weekday) ? label : day.weekday,
      long: long(expiry),
    };
  });
}

/**
 * The empty-state heading for a day with no asks: "No asks for Fri 25 yet". "Today" is a chip
 * label, so mid-sentence it is lowercased ("No asks for today yet"), never "No asks for Today yet".
 * `null` is the caller's "no day is chosen" (the Buy home with no listed expiries, a market page before one loads).
 */
export function noAsksHeading(dayLabel: string | null, fallback: string): string {
  if (dayLabel === null || dayLabel === "") return fallback;
  return `No asks for ${dayLabel === "Today" ? "today" : dayLabel} yet`;
}

/**
 * One expiry as the day label, outside the picker: "Today" when it is `now`'s New York day,
 * otherwise "Wed 23". Portfolio position rows use it ("Fri 25 · 4.54 sh"). A past expiry keeps
 * its weekday label; with no clock yet (`now` null) there is no "Today" to claim, so it is the weekday label too.
 */
export function expiryDayLabel(expiry: number, now: number | null): string {
  const day = nyDay(expiry);
  return now !== null && nyDay(now).key === day.key ? "Today" : `${day.weekday} ${day.day}`;
}
