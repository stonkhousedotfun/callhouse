import { describe, expect, it } from "vitest";
import { isWeeklyExpiry } from "../../lib/v2/calendar";

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
});
