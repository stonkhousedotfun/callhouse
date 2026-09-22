/**
 * The one America/New_York formatter set (UX review item 8).
 *
 * THE POINT OF THESE TESTS is the zone. Six inline formatters were collapsed into one, and the
 * risk in doing that is not a typo — it is that a later edit quietly drops `timeZone` and every
 * timestamp in the app starts rendering in the runner's local zone, which on a CI box in UTC
 * looks plausible and on a London reader's phone puts a 4pm ET cutoff at 21:00.
 */
import { describe, expect, it } from "vitest";

import { countdown, dayStamp, NEW_YORK_TIME_ZONE, stamp } from "./time";

/** 2026-09-18 20:00:00Z = 16:00 New York (EDT). A fixed instant, so the assertion is exact. */
const INSTANT = Date.UTC(2026, 8, 18, 20, 0, 0) / 1000;

describe("New York timestamps", () => {
  it("renders the New York time, not the runner's local time", () => {
    // The load-bearing assertion. 20:00Z is 16:00 in New York; if the zone is ever dropped this
    // reads 8:00 PM on a UTC runner and the test goes red instead of the app going wrong.
    expect(stamp(INSTANT)).toBe("Sep 18, 2026, 4:00 PM EDT");
    expect(NEW_YORK_TIME_ZONE).toBe("America/New_York");
  });

  it("NAMES THE ZONE IN THE OUTPUT, because the doc comment promises it does", () => {
    // T-460. time.ts:10-13 argues that a timestamp rendered in an assumed zone is how a London
    // reader misses a 4pm New York cutoff, and concludes "the zone is therefore fixed here and
    // named in the output". For a while it was not: `dateStyle`/`timeStyle` render no zone, so
    // stamp() said "Sep 18, 2026, 4:00 PM" and the comment was aspirational.
    //
    // This asserts the PROPERTY the comment promises, not just today's string, so it stays
    // meaningful if the date format is ever restyled: whatever else changes, a moment names the
    // zone it is in.
    expect(stamp(INSTANT)).toMatch(/\b(EDT|EST)$/);
  });

  it("names the RIGHT zone on each side of the daylight-saving boundary", () => {
    // A hard-coded "EDT" suffix would pass the assertion above all year and be wrong for four
    // months of it. Same wall-clock time, opposite sides of the US DST change.
    const summer = Date.UTC(2026, 8, 21, 20, 0, 0) / 1000; // 16:00 New York, EDT
    const winter = Date.UTC(2026, 0, 21, 21, 0, 0) / 1000; // 16:00 New York, EST
    expect(stamp(summer)).toBe("Sep 21, 2026, 4:00 PM EDT");
    expect(stamp(winter)).toBe("Jan 21, 2026, 4:00 PM EST");
  });

  it("a day stamp does NOT name a zone, because a day has no time of day to misread", () => {
    // Deliberately asymmetric with stamp(). The comment's argument is about a moment being read
    // in the wrong zone; "Sep 18, 2026 EDT" adds a suffix to something nobody can misread as a
    // clock time. Asserted so the asymmetry is a decision on the record, not an oversight.
    expect(dayStamp(INSTANT)).not.toMatch(/\b(EDT|EST)\b/);
  });

  it("a day stamp drops the time and keeps the same day", () => {
    expect(dayStamp(INSTANT)).toBe("Sep 18, 2026");
  });

  it("the day is New York's day, not UTC's, across the midnight boundary", () => {
    // 2026-09-19 02:00Z is still the 18th in New York. A formatter that lost its zone would say
    // the 19th, and no assertion on a mid-afternoon timestamp would ever catch that.
    const afterUtcMidnight = Date.UTC(2026, 8, 19, 2, 0, 0) / 1000;
    expect(dayStamp(afterUtcMidnight)).toBe("Sep 18, 2026");
  });

  it("counts down in the largest two units, and says 'now' once it has run out", () => {
    expect(countdown(INSTANT + 2 * 86_400 + 4 * 3_600, INSTANT)).toBe("2d 4h");
    expect(countdown(INSTANT + 3 * 3_600 + 12 * 60, INSTANT)).toBe("3h 12m");
    expect(countdown(INSTANT + 8 * 60, INSTANT)).toBe("8m");
    // A deadline that has passed is a STATE, not a negative measurement: "-3m" or "0m" both read
    // as a rendering fault on a card that is actually closing.
    expect(countdown(INSTANT, INSTANT)).toBe("now");
    expect(countdown(INSTANT - 600, INSTANT)).toBe("now");
  });

  it("refuses a non-finite timestamp rather than rendering 'Invalid Date'", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => stamp(bad)).toThrow(/unix seconds/);
      expect(() => dayStamp(bad)).toThrow(/unix seconds/);
      expect(() => countdown(bad, INSTANT)).toThrow(/unix seconds/);
    }
  });
});
