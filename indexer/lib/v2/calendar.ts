/** Mirror ExpiryCalendar._isWeeklyDay for a series that the contract already accepted. */
const closeTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const weekday = (day: number) => new Date(day * 86_400_000).getUTCDay();
const businessDay = (day: number) => weekday(day) !== 0 && weekday(day) !== 6;

export function isWeeklyExpiry(expiry: bigint, holidays: ReadonlyMap<number, boolean>): boolean {
  const day = Number(expiry / 86_400n);
  const time = Object.fromEntries(closeTime.formatToParts(new Date(Number(expiry) * 1000))
    .map((part) => [part.type, part.value]));
  if (time.hour !== "16" || time.minute !== "00" || time.second !== "00" ||
      !businessDay(day) || holidays.get(day) === true) return false;
  for (let later = day + 1; businessDay(later); later++) {
    if (holidays.get(later) !== true) return false;
  }
  return true;
}
