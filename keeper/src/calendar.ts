/**
 * The weekly clock: when this week's option type exercises and expires.
 *
 * With no registry the keeper picks the tuple itself, and the tuple is immutable once created,
 * so this is the one place the week's timestamps are decided. The rule is Overcall's documented
 * one (projects/callhouse/integrations/overcall.md, "exerciseTimestamp is the NYSE Friday 16:00
 * ET close"), reproduced rather than improvised so a buyer sees the same expiry convention on
 * every venue:
 *
 *   exerciseTs  the next NYSE Friday 16:00 America/New_York. 20:00 UTC in daylight time, 21:00
 *               UTC in standard time — computed through Intl, never by adding a fixed offset, so
 *               the DST switch (1 Nov 2026, 14 Mar 2027) needs no code change.
 *   holidays    a FULL-DAY NYSE holiday on the Friday rolls the close back to the previous
 *               session's close (Thursday 16:00 ET; Wednesday if Thursday is shut too). Early
 *               closes (the day after Thanksgiving, Christmas Eve) are not modelled: the feed
 *               still prints on those days and the vault's clock is a timestamp, not a session.
 *   expiryTs    exerciseTs + 24 h. Valorem needs a minute, the vault needs a day
 *               (ValoremLib.MIN_EXERCISE_WINDOW); a day is what Overcall's cycles use.
 *   lead        if the candidate exercise is closer than `minLeadSeconds` the following Friday
 *               is used instead. The vault refuses `ExerciseTooSoon` under an hour; the keeper's
 *               own lead (KEEPER_ARM_LEAD_S) is at least that and normally more, because arming
 *               an hour before the close sells an hour of calls for a week of collateral lock.
 *
 * Everything here is pure and takes `nowSeconds` (the head block's timestamp, never the wall
 * clock), so a fork that warps time and a unit test both drive it.
 */

/**
 * Full-day NYSE closures, 2026 and 2027, from the exchange's published calendar. Only weekday
 * dates matter to the keeper (a Saturday holiday moves nothing) but the table is kept whole so
 * it can be read against the source. KEEPER_NYSE_HOLIDAYS replaces it for years past 2027.
 *
 *   2026: New Year's Day, MLK Day, Presidents' Day, Good Friday, Memorial Day, Juneteenth,
 *         Independence Day (observed Fri 3 Jul), Labor Day, Thanksgiving, Christmas.
 *   2027: New Year's Day (Fri 1 Jan), MLK Day, Presidents' Day, Good Friday, Memorial Day,
 *         Juneteenth (observed Fri 18 Jun), Independence Day (observed Mon 5 Jul), Labor Day,
 *         Thanksgiving, Christmas (observed Fri 24 Dec).
 */
export const NYSE_HOLIDAYS_2026_2027: readonly string[] = [
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24',
];

export const NEW_YORK = 'America/New_York';

/** The regular NYSE close, local time. */
export const CLOSE_HOUR_ET = 16;

/** Exercise window: the vault's MIN_EXERCISE_WINDOW and Overcall's convention are both one day. */
export const EXERCISE_WINDOW_SECONDS = 86_400;

/** The vault's own floor (ValoremLib.MIN_LEAD). KEEPER_ARM_LEAD_S may not go below it. */
export const VAULT_MIN_LEAD_SECONDS = 3_600;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse KEEPER_NYSE_HOLIDAYS ("2028-01-17,2028-02-21"); an empty value means the built-in table. */
export function parseHolidays(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === '') return NYSE_HOLIDAYS_2026_2027;
  const dates = raw
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d !== '');
  for (const date of dates) {
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw new Error(`KEEPER_NYSE_HOLIDAYS: not a YYYY-MM-DD date: ${date}`);
    }
  }
  return dates;
}

/*//////////////////////////////////////////////////////////////
                         NEW YORK LOCAL TIME
//////////////////////////////////////////////////////////////*/

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, in New York. */
  weekday: number;
  /** The zone's offset from UTC at that instant, in seconds (-4 h in EDT, -5 h in EST). */
  offsetSeconds: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
  timeZoneName: 'shortOffset',
});

/** The New York wall clock at a UTC instant. */
export function newYorkParts(unixSeconds: number): LocalParts {
  const parts = formatter.formatToParts(new Date(unixSeconds * 1000));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // Intl renders midnight as "24" under hour12:false in some engines; normalise.
  const hour = Number(get('hour')) % 24;
  const offset = parseOffset(get('timeZoneName'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? -1,
    offsetSeconds: offset,
  };
}

/** "GMT-4" | "GMT-5" | "GMT+5:30" -> seconds east of UTC. */
function parseOffset(label: string): number {
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(label);
  if (!m) return 0; // "GMT" alone is +0
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const minutes = Number(m[3] ?? '0');
  return sign * (hours * 3600 + minutes * 60);
}

/**
 * The UTC instant of `hour:00:00` New York time on a calendar day. Resolved through the zone's
 * offset AT THAT INSTANT, so a day on either side of a DST switch comes out right: a first
 * guess from UTC is corrected by whatever offset New York reports for it.
 */
export function newYorkTimeToUnix(year: number, month: number, day: number, hour: number): number {
  let guess = Math.floor(Date.UTC(year, month - 1, day, hour, 0, 0) / 1000);
  for (let i = 0; i < 3; i += 1) {
    const local = newYorkParts(guess);
    const corrected = Math.floor(Date.UTC(year, month - 1, day, hour, 0, 0) / 1000) - local.offsetSeconds;
    if (corrected === guess) break;
    guess = corrected;
  }
  return guess;
}

function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Shift a calendar day by whole days (UTC arithmetic on a date-only value is exact). */
function shiftDay(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/*//////////////////////////////////////////////////////////////
                           THE DECISION
//////////////////////////////////////////////////////////////*/

export interface WeekWindow {
  /** The option type's exerciseTimestamp: the session close the calls settle against. */
  exerciseTs: number;
  /** exerciseTs + 24 h. */
  expiryTs: number;
  /** The Friday the week is named after, YYYY-MM-DD in New York. */
  friday: string;
  /** The day the close actually lands on (differs from `friday` in a holiday week). */
  closeDay: string;
  /** How many Fridays were skipped for the lead rule. 0 in the normal case. */
  skippedForLead: number;
}

/**
 * The next weekly window from `nowSeconds`.
 *
 *   1. Take the next Friday on or after today (New York). If today is Friday and its close is
 *      still at least `minLeadSeconds` away, it is this Friday.
 *   2. If that Friday is a full-day holiday, walk back to the last open weekday: Thursday, or
 *      Wednesday if Thursday is shut too.
 *   3. If the resulting close is less than `minLeadSeconds` away (or already past), start over
 *      from the following Friday. Bounded: three tries covers any holiday cluster in the table.
 */
export function nextWeekWindow(nowSeconds: number, minLeadSeconds: number, holidays: readonly string[] = NYSE_HOLIDAYS_2026_2027): WeekWindow {
  if (minLeadSeconds < VAULT_MIN_LEAD_SECONDS) {
    throw new Error(`minLeadSeconds ${minLeadSeconds} is below the vault's MIN_LEAD of ${VAULT_MIN_LEAD_SECONDS}`);
  }
  const closed = new Set(holidays);
  const today = newYorkParts(nowSeconds);
  // Days until Friday (5) from today, 0 if today is Friday.
  let daysAhead = (5 - today.weekday + 7) % 7;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const friday = shiftDay(today.year, today.month, today.day, daysAhead);
    let close = friday;
    let steps = 0;
    while (closed.has(isoDay(close.year, close.month, close.day)) && steps < 4) {
      close = shiftDay(close.year, close.month, close.day, -1);
      steps += 1;
    }
    const exerciseTs = newYorkTimeToUnix(close.year, close.month, close.day, CLOSE_HOUR_ET);
    if (exerciseTs >= nowSeconds + minLeadSeconds) {
      return {
        exerciseTs,
        expiryTs: exerciseTs + EXERCISE_WINDOW_SECONDS,
        friday: isoDay(friday.year, friday.month, friday.day),
        closeDay: isoDay(close.year, close.month, close.day),
        skippedForLead: attempt,
      };
    }
    daysAhead += 7;
  }
  throw new Error(`no weekly window within four Fridays of ${nowSeconds}`);
}

/** A human label for a timestamp in both clocks, for alerts and logs. */
export function describeInstant(unixSeconds: number): string {
  const ny = newYorkParts(unixSeconds);
  const utc = new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');
  const offsetH = ny.offsetSeconds / 3600;
  return `${utc} (${isoDay(ny.year, ny.month, ny.day)} ${String(ny.hour).padStart(2, '0')}:${String(ny.minute).padStart(2, '0')} ET, UTC${offsetH >= 0 ? '+' : ''}${offsetH})`;
}
