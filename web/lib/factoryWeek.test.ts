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
