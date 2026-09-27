import { describe, expect, it } from "vitest";
import { closeOfDay, isCalendarSessionDay, isWeeklyExpiry, nextExpiry, yearDays, yearOfDay } from "../../lib/v2/calendar";

const at = (year: number, month: number, day: number, hourUtc: number) =>
  BigInt(Date.UTC(year, month - 1, day, hourUtc) / 1000);
const day = (year: number, month: number, date: number) =>
  Date.UTC(year, month - 1, date) / 86_400_000;

describe("event-sourced weekly classification", () => {
  it("uses the New York close across EST and EDT", () => {
    expect(isWeeklyExpiry(at(2026, 1, 9, 21), new Map())).toBe(true);
    expect(isWeeklyExpiry(at(2026, 9, 18, 20), new Map())).toBe(true);
    expect(isWeeklyExpiry(at(2026, 9, 18, 21), new Map())).toBe(false);
  });

  it("moves a weekly to Thursday when Friday is a holiday", () => {
    const friday = day(2026, 4, 3); // Good Friday
    expect(isWeeklyExpiry(at(2026, 4, 2, 20), new Map())).toBe(false);
    expect(isWeeklyExpiry(at(2026, 4, 2, 20), new Map([[friday, true]]))).toBe(true);
    expect(isWeeklyExpiry(at(2026, 4, 3, 20), new Map([[friday, true]]))).toBe(false);
  });

  it("keeps a non-close special expiry distinct from a weekly", () => {
    expect(isWeeklyExpiry(at(2026, 9, 18, 19), new Map())).toBe(false);
  });

  it("mirrors nextExpiry overlap at a Friday head and skips committed holidays", () => {
    const after = Date.UTC(2027, 0, 15, 9, 5) / 1_000;
    const holidays = new Map([[day(2027, 1, 18), true]]);
    const fridayClose = Number(at(2027, 1, 15, 21));
    expect(closeOfDay(day(2027, 1, 15))).toBe(fridayClose);
    expect(nextExpiry(after, false, holidays)).toBe(fridayClose);
    expect(nextExpiry(after, true, holidays)).toBe(fridayClose);
    expect(nextExpiry(fridayClose, false, holidays)).toBe(Number(at(2027, 1, 19, 21)));
    expect(nextExpiry(fridayClose, true, holidays)).toBe(Number(at(2027, 1, 22, 21)));
  });
});

// ExpiryCalendar._isSessionDay's AN UNSEEDED YEAR FAILS CLOSED term.
describe("fail-closed unseeded years", () => {
  it("yearOfDay and yearDays mirror the calendar's integer year math", () => {
    const wrong: number[] = [];
    for (let d = 0; d <= 200_000; d++) {
      if (yearOfDay(d) !== new Date(d * 86_400_000).getUTCFullYear()) wrong.push(d);
    }
    expect(wrong).toEqual([]);
    // The route's range cap: Date's last valid day.
    expect(yearOfDay(100_000_000)).toBe(new Date(100_000_000 * 86_400_000).getUTCFullYear());
    for (let year = 1970; year <= 2600; year++) {
      expect(yearDays(year)).toEqual([day(year, 1, 1), day(year + 1, 1, 1) - 1]);
    }
  });

  it("closes every weekday of an unseeded year only in the fail-closed mode", () => {
    const monday = day(2031, 1, 6);
    const seeded2027 = new Set([2027]);
    expect(isCalendarSessionDay(monday, new Map(), true, seeded2027)).toBe(false);
    expect(isCalendarSessionDay(monday, new Map(), false, seeded2027)).toBe(true);
    expect(isCalendarSessionDay(monday, new Map(), true, new Set([2031]))).toBe(true);
    // A seeded year's holidays and weekends stay closed; the switch never opens a day.
    expect(isCalendarSessionDay(monday, new Map([[monday, true]]), true, new Set([2031]))).toBe(false);
    expect(isCalendarSessionDay(day(2031, 1, 4), new Map(), true, new Set([2031]))).toBe(false); // Saturday
  });
});
