/** Pure mirrors of ExpiryCalendar's post-2007 New York close grid. */
export const CALENDAR_DAY_S = 86_400;
export const NEXT_EXPIRY_SEARCH_S = 14 * CALENDAR_DAY_S;

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
