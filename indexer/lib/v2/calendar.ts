/** Pure mirrors of ExpiryCalendar's post-2007 New York close grid. */
export const CALENDAR_DAY_S = 86_400;
export const NEXT_EXPIRY_SEARCH_S = 14 * CALENDAR_DAY_S;
/** v2CalendarMode's one row, keyed by source name like v2ContractAuthority. */
export const CALENDAR_MODE_ID = "expirycalendar";

function dstDays(year: number): readonly [number, number] {
  const march1 = Date.UTC(year, 2, 1) / (CALENDAR_DAY_S * 1_000);
  const start = march1 + (7 - ((march1 + 4) % 7)) % 7 + 7;
  const november1 = Date.UTC(year, 10, 1) / (CALENDAR_DAY_S * 1_000);
  const end = november1 + (7 - ((november1 + 4) % 7)) % 7;
  return [start, end];
}

/** ExpiryCalendar.closeOf(dayIndex): 16:00 New York, 20:00 UTC in EDT and 21:00 in EST. */
export function closeOfDay(day: number): number {
  const year = new Date(day * CALENDAR_DAY_S * 1_000).getUTCFullYear();
  const [start, end] = dstDays(year);
  return day * CALENDAR_DAY_S + (day >= start && day < end ? 20 * 3_600 : 21 * 3_600);
}

function sessionDay(day: number, holidays: ReadonlyMap<number, boolean>): boolean {
  return (day + 3) % 7 < 5 && holidays.get(day) !== true;
}

function weeklyDay(day: number, holidays: ReadonlyMap<number, boolean>): boolean {
  if (!sessionDay(day, holidays)) return false;
  for (let later = day + 1; (later + 3) % 7 < 5; later++) {
    if (holidays.get(later) !== true) return false;
  }
  return true;
}

export function isWeeklyExpiry(expiry: bigint, holidays: ReadonlyMap<number, boolean>): boolean {
  const seconds = Number(expiry);
  const day = Math.floor(seconds / CALENDAR_DAY_S);
  return seconds === closeOfDay(day) && weeklyDay(day, holidays);
}

/** Exact local mirror of ExpiryCalendar.nextExpiry's grid-only, strict-after 14-day search. */
export function nextExpiry(afterTs: number, weekly: boolean, holidays: ReadonlyMap<number, boolean>): number {
  const limit = afterTs + NEXT_EXPIRY_SEARCH_S;
  for (let day = Math.floor(afterTs / CALENDAR_DAY_S); ; day++) {
    const close = closeOfDay(day);
    if (close > limit) break;
    if (close > afterTs && (weekly ? weeklyDay(day, holidays) : sessionDay(day, holidays))) return close;
  }
  throw new Error(`ExpiryCalendar.nextExpiry found no ${weekly ? "weekly" : "daily"} close after ${afterTs}`);
}

/**
 * ExpiryCalendar._yearOf, line for line (Hinnant's civil_from_days for day >= 0): the calendar year
 * of day index `day`. Integer arithmetic, not Date, so it holds past Date's range.
 */
export function yearOfDay(day: number): number {
  const z = day + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  return yoe + era * 400 + (mp >= 10 ? 1 : 0);
}

/** ExpiryCalendar._daysFromCivil(year, 1, 1): the day index of January 1 of `year` (>= 1970). */
function januaryFirst(year: number): number {
  const y = year - 1; // January belongs to the previous March-based year
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + 306; // doy of January 1 is 306
  return era * 146_097 + doe - 719_468;
}

/** First and last day index of `year`, inclusive. */
export function yearDays(year: number): readonly [number, number] {
  return [januaryFirst(year), januaryFirst(year + 1) - 1];
}

/**
 * ExpiryCalendar._isSessionDay: Monday-Friday, not a holiday and, when the calendar fails closed
 * (`unseededYearsClosed`, set by a constructor given at least one closure), in a year with at least
 * one closure currently set (`_isSeededYear`). `seededYears` holds the years whose count of set
 * closures is non-zero; a closure on any day counts, exactly as `_closuresInYear` does.
 */
export function isCalendarSessionDay(day: number, holidays: ReadonlyMap<number, boolean>,
  unseededYearsClosed: boolean, seededYears: ReadonlySet<number>): boolean {
  return sessionDay(day, holidays) && (!unseededYearsClosed || seededYears.has(yearOfDay(day)));
}
