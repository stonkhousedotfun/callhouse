/**
 * Day picker options. The fixed instants below are checked by hand against the New York calendar:
 * 2026-09-22 is a Tuesday, and a 20:00 UTC expiry is 4:00 PM EDT on the same date.
 */
import { describe, expect, it } from "vitest";

import { DAY_PICKER_MAX, dayOptions, expiryDayLabel, noAsksHeading, RESALE_ONLY_NOTE } from "./dayPicker";

/** 20:00 UTC on 2026-09-<day>, i.e. the 4pm ET close that day, in unix seconds. */
const close = (day: number) => Date.UTC(2026, 8, day, 20, 0, 0) / 1000;
/** 14:00 UTC on Tue 2026-09-22 = 10:00 EDT. */
const NOW = Date.UTC(2026, 8, 22, 14, 0, 0) / 1000;

describe("dayOptions", () => {
  it("labels today's close 'Today' and later closes 'Wed 23'", () => {
    const got = dayOptions([close(22), close(23), close(24)], NOW);
    expect(got.map((o) => o.label)).toEqual(["Today", "Wed 23", "Thu 24"]);
    expect(got.map((o) => o.short)).toEqual(["Today", "Wed", "Thu"]);
    expect(got[1].long).toBe("Sep 23, 2026, 4:00 PM EDT");
  });

  it("uses the New York day, not UTC: 02:00 UTC Wed is still Tuesday in New York", () => {
    // 02:00 UTC on 2026-09-23 is 22:00 EDT on the 22nd. In UTC `now` is already Wednesday, so a UTC reading
    // would call this close "Today".
    const now = Date.UTC(2026, 8, 23, 2, 0, 0) / 1000;
    expect(dayOptions([close(23)], now)[0].label).toBe("Wed 23");
    const lateTuesday = Date.UTC(2026, 8, 23, 3, 0, 0) / 1000; // 23:00 EDT Tue
    expect(dayOptions([lateTuesday], Date.UTC(2026, 8, 22, 20, 30) / 1000)[0].label).toBe("Today");
  });

  it("offers only listed expiries, in order, once each", () => {
    const got = dayOptions([close(25), close(23), close(25), close(28)], NOW);
    expect(got.map((o) => o.expiry)).toEqual([close(23), close(25), close(28)]);
    expect(got.map((o) => o.label)).toEqual(["Wed 23", "Fri 25", "Mon 28"]);
  });

  it("drops expiries at or before now", () => {
    expect(dayOptions([close(21), NOW, close(22)], NOW).map((o) => o.expiry)).toEqual([close(22)]);
  });

  it(`caps at ${DAY_PICKER_MAX}, keeping the nearest`, () => {
    const eight = [22, 23, 24, 25, 26, 27, 28, 29].map(close);
    const got = dayOptions(eight, NOW);
    expect(got).toHaveLength(6);
    expect(got.at(-1)?.expiry).toBe(close(27));
    // The control: the cap is the thing doing the work, not the input.
    expect(dayOptions(eight, NOW, 8)).toHaveLength(8);
  });

  it("returns nothing, rather than a made-up calendar, when nothing is listed", () => {
    expect(dayOptions([], NOW)).toEqual([]);
  });

  it("refuses a non-finite now", () => {
    expect(() => dayOptions([close(23)], Number.NaN)).toThrow(RangeError);
  });
});

/**
 * /nvda at 390px read "Today · Thu · Fri · Fri": six expiries can span more than a week, and the phone
 * tab was the weekday alone. The instants are derived with Python's zoneinfo, independently of this module:
 * 16:00 America/New_York on Thu 2026-09-24 = 1790280000, Fri 2026-09-25 = 1790366400, Fri 2026-10-02 = 1790971200,
 * Fri 2026-12-25 (EST) = 1798232400; `now` is 10:00 New York on Wed 2026-09-23 = 1790172000.
 */
describe("dayOptions: no two chips on different days read the same", () => {
  const WED = 1_790_172_000;
  const THU_24 = 1_790_280_000;
  const FRI_25 = 1_790_366_400;
  const FRI_2 = 1_790_971_200;
  const FRI_DEC_25 = 1_798_232_400;

  it("Thu 24, Fri 25 and Fri 2 get three different phone tabs, and no expiry is dropped", () => {
    const got = dayOptions([THU_24, FRI_25, FRI_2], WED);
    expect(got.map((o) => o.expiry)).toEqual([THU_24, FRI_25, FRI_2]);
    expect(got.map((o) => o.short)).toEqual(["Thu", "Fri 25", "Fri 2"]);
    expect(new Set(got.map((o) => o.short)).size).toBe(got.length);
    // The desktop labels were already distinct and are unchanged.
    expect(got.map((o) => o.label)).toEqual(["Thu 24", "Fri 25", "Fri 2"]);
  });

  it("only the colliding tabs change: a lone weekday keeps its short tab", () => {
    const got = dayOptions([WED + 3_600, THU_24, FRI_25, FRI_2], WED);
    expect(got.map((o) => o.short)).toEqual(["Today", "Thu", "Fri 25", "Fri 2"]);
  });

  it("'Today' is not a weekday tab, so a later day of the same weekday keeps its short label", () => {
    // Wed 2026-09-30 16:00 New York = 1790798400.
    expect(dayOptions([WED + 3_600, 1_790_798_400], WED).map((o) => o.short)).toEqual(["Today", "Wed"]);
  });

  it("two expiries on the SAME New York day still share a label, as documented", () => {
    const noon = FRI_25 - 4 * 3_600;
    const got = dayOptions([noon, FRI_25], WED);
    expect(got.map((o) => o.short)).toEqual(["Fri", "Fri"]);
    expect(got[0]!.long).not.toBe(got[1]!.long);
  });

  it("the same weekday and date months apart adds the month, at every width", () => {
    const got = dayOptions([FRI_25, FRI_DEC_25], WED);
    expect(got.map((o) => o.label)).toEqual(["Fri Sep 25", "Fri Dec 25"]);
    expect(got.map((o) => o.short)).toEqual(["Fri Sep 25", "Fri Dec 25"]);
  });
});

describe("expiryDayLabel", () => {
  it("is Today on the New York day of now, and 'Wed 23' otherwise", () => {
    expect(expiryDayLabel(close(22), NOW)).toBe("Today");
    expect(expiryDayLabel(close(23), NOW)).toBe("Wed 23");
    expect(expiryDayLabel(close(25), NOW)).toBe("Fri 25");
  });

  it("uses the New York day: 02:00 UTC Wed is Tue 22 in New York", () => {
    expect(expiryDayLabel(Date.UTC(2026, 8, 23, 2, 0, 0) / 1000, null)).toBe("Tue 22");
  });

  it("claims no Today without a clock, and keeps a past expiry's weekday", () => {
    expect(expiryDayLabel(close(22), null)).toBe("Tue 22");
    expect(expiryDayLabel(close(21), NOW)).toBe("Mon 21");
  });
});

describe("noAsksHeading", () => {
  it("names the day, lowercases Today mid-sentence, and falls back when there is no day", () => {
    expect(noAsksHeading("Fri 25", "x")).toBe("No asks for Fri 25 yet");
    expect(noAsksHeading("Today", "x")).toBe("No asks for today yet");
    expect(noAsksHeading(null, "No daily expiries listed yet")).toBe("No daily expiries listed yet");
    expect(noAsksHeading("", "fallback")).toBe("fallback");
  });
});

describe("dayOptions: resale-only days", () => {
  it("marks a listed day past its mint cutoff, keeps its label, and says why in the long form", () => {
    const got = dayOptions([close(22), close(23), close(24)], NOW, DAY_PICKER_MAX, [close(22)]);
    expect(got.map((o) => o.label)).toEqual(["Today", "Wed 23", "Thu 24"]);
    expect(got[0]).toMatchObject({ resaleOnly: true, long: `Sep 22, 2026, 4:00 PM EDT · ${RESALE_ONLY_NOTE}` });
    expect("resaleOnly" in got[1]!, "a writable day has no flag at all").toBe(false);
    expect(got[1]!.long).toBe("Sep 23, 2026, 4:00 PM EDT");
  });

  it("a resale-only day is still capped and dropped like any other, and an unlisted one adds nothing", () => {
    expect(dayOptions([close(21), close(23)], NOW, DAY_PICKER_MAX, [close(21), close(25)]).map((o) => o.expiry))
      .toEqual([close(23)]);
    expect(dayOptions([close(23)], NOW, DAY_PICKER_MAX, [close(25)])[0]!.resaleOnly).toBeUndefined();
  });
});

// `long` follows the reader's zone when one is passed; chips stay New York market days.
describe("dayOptions with the reader's zone", () => {
  it("long is the reader's time with ET beside it; omitted, the New York stamp", () => {
    const [withZone] = dayOptions([close(24)], NOW, undefined, [], "America/Los_Angeles");
    expect(withZone.long).toBe("Sep 24, 1:00 PM PDT (4:00 PM ET)");
    expect(withZone.label).toBe("Thu 24");
    expect(dayOptions([close(24)], NOW)[0].long).toBe("Sep 24, 2026, 4:00 PM EDT");
  });
});
