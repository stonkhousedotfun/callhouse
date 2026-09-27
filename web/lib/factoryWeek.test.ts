import { describe, expect, it } from "vitest";

import { parseFactoryWeek } from "./factoryWeek";

const NAMED = {
  id: 1,
  strikeUsdg: 223_000_000n,
  exerciseTs: 1_789_761_600,
  baseExpiryTs: 1_789_848_000,
  askUsdg: 1_000_000n,
};

describe("parseFactoryWeek", () => {
  it("reads viem's named tuple", () => {
    expect(parseFactoryWeek(NAMED)).toEqual(NAMED);
  });

  it("reads a positional array", () => {
    expect(parseFactoryWeek([1, 223_000_000n, 1_789_761_600, 1_789_848_000, 1_000_000n])).toEqual(NAMED);
  });

  it("reads bigint ids and timestamps", () => {
    expect(
      parseFactoryWeek({
        id: 1n,
        strikeUsdg: 223_000_000n,
        exerciseTs: 1_789_761_600n,
        baseExpiryTs: 1_789_848_000n,
        askUsdg: 1_000_000n,
      }),
    ).toEqual(NAMED);
  });

  it("treats a missing week as undefined, not id 0", () => {
    expect(parseFactoryWeek(undefined)).toBeUndefined();
    expect(parseFactoryWeek(null)).toBeUndefined();
    expect(parseFactoryWeek({})).toBeUndefined();
  });

  it("reads a closed week (id 0) once the tuple is present", () => {
    expect(parseFactoryWeek({ ...NAMED, id: 0 })?.id).toBe(0);
  });
});

describe("parseFactoryWeek string and malformed fields", () => {
  it("reads decimal strings as returned by a JSON transport", () => {
    expect(
      parseFactoryWeek({ id: "1", strikeUsdg: "223000000", exerciseTs: "1789761600", baseExpiryTs: "1789848000", askUsdg: "1000000" }),
    ).toEqual(NAMED);
  });

  it("reads a finite number as a bigint amount", () => {
    expect(parseFactoryWeek({ ...NAMED, strikeUsdg: 223_000_000 })?.strikeUsdg).toBe(223_000_000n);
  });

  it("refuses non-numeric, empty, non-finite and wrong-typed fields", () => {
    expect(parseFactoryWeek({ ...NAMED, strikeUsdg: "2.5" })).toBeUndefined();
    expect(parseFactoryWeek({ ...NAMED, strikeUsdg: "" })).toBeUndefined();
    expect(parseFactoryWeek({ ...NAMED, askUsdg: Number.NaN })).toBeUndefined();
    expect(parseFactoryWeek({ ...NAMED, askUsdg: true })).toBeUndefined();
    expect(parseFactoryWeek({ ...NAMED, id: "abc" })).toBeUndefined();
    expect(parseFactoryWeek({ ...NAMED, id: "" })).toBeUndefined();
    expect(parseFactoryWeek({ ...NAMED, exerciseTs: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(parseFactoryWeek({ ...NAMED, baseExpiryTs: {} })).toBeUndefined();
    expect(parseFactoryWeek("week")).toBeUndefined();
  });
});
