/**
 * New York calendar arithmetic for the rules: expiries are 16:00 New York (ADR-07), the regular
 * session is 09:30-16:00 New York on a session day (IExpiryCalendar.isRegularSession), and "a day"
 * in "once per direction per day" is a New York trading date.
 *
 * SESSION DAYS COME FROM THE INDEXER (GET /v2/calendar/holidays): a session day is a weekday the
 * on-chain ExpiryCalendar has not marked a holiday. Days are keyed by the API's day index,
 * floor(unix / 86400) of that New York date's 16:00 close; 16:00 New York is 20:00Z (EDT) or
 * 21:00Z (EST), so the index is the UTC day number of the New York date itself. The engine fetches
 * and caches the days it needs (engine.ts) and hands them to the rules as `Snapshot.sessionDays`.
 * The rules never guess: a day the calendar has not answered for makes a rule wait instead of
 * counting it as a session, so a holiday can no longer bring the auto_roll warning forward.
 */

const NY = 'America/New_York';

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

interface NyParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
}

function nyParts(unixSeconds: number): NyParts {
  const got: Record<string, string> = {};
  for (const part of partsFormat.formatToParts(new Date(unixSeconds * 1000))) {
    if (part.type !== 'literal') got[part.type] = part.value;
  }
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    hour: Number(got.hour === '24' ? '0' : got.hour),
    minute: Number(got.minute),
    weekday: got.weekday ?? '',
  };
}

/** "2026-09-18": the New York date of an instant. */
export function nyDate(unixSeconds: number): string {
  const p = nyParts(unixSeconds);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The instant of `hour:minute` New York wall time on a New York date (EDT or EST, whichever is in force). */
export function nyWallTime(year: number, month: number, day: number, hour: number, minute: number): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  for (const offsetHours of [4, 5]) {
    const candidate = naive + offsetHours * 3600;
    const p = nyParts(candidate);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return candidate;
  }
  // Only a wall time inside a DST gap lands here; 09:30 and 16:00 never do.
  return naive + 5 * 3600;
}

/** 09:30 New York on the New York date of `unixSeconds`. */
export function sessionOpenOf(unixSeconds: number): number {
  const p = nyParts(unixSeconds);
  return nyWallTime(p.year, p.month, p.day, 9, 30);
}

/* ------------------------------------------------------------------ session days */

/** Day index (as a string key) → isSessionDay, as GET /v2/calendar/holidays answered. */
export type SessionDays = Readonly<Record<string, boolean>>;

/**
 * How many days past a date the rules look for the next session day. The longest run of
 * non-session days on record is a weekend plus a few closure days; ten is well past it.
 */
export const SESSION_SCAN_DAYS = 10;

/** The API day index of the New York date of an instant. */
export function dayIndexOf(unixSeconds: number): number {
  const p = nyParts(unixSeconds);
  return Date.UTC(p.year, p.month - 1, p.day) / 86_400_000;
}

/** 09:30 New York on the New York date with this day index. */
export function sessionOpenOfDay(dayIndex: number): number {
  const d = new Date(dayIndex * 86_400_000);
  return nyWallTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30);
}

/**
 * The first session day strictly after `afterDay`. null when the calendar has not answered for a
 * day on the way (the caller waits for it), or when there is none within SESSION_SCAN_DAYS.
 */
export function nextSessionDay(afterDay: number, sessionDays: SessionDays): number | null {
  for (let day = afterDay + 1; day <= afterDay + SESSION_SCAN_DAYS; day += 1) {
    const isSession = sessionDays[String(day)];
    if (isSession === undefined) return null;
    if (isSession) return day;
  }
  return null;
}
