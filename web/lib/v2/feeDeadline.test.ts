import { describe, expect, it } from "vitest";
import { feeBoundTakeDeadline } from "./feeDeadline";

describe("feeBoundTakeDeadline", () => {
  const now = 1_789_620_000;

  it("caps a quote before the on-chain fee activation second", () => {
    expect(feeBoundTakeDeadline(now, BigInt(now + 200))).toBe(now + 199);
    expect(feeBoundTakeDeadline(now, BigInt(now + 300))).toBe(now + 299);
  });

  it("uses the normal lifetime when there is no upcoming change within it", () => {
    expect(feeBoundTakeDeadline(now, null)).toBe(now + 300);
    expect(feeBoundTakeDeadline(now, BigInt(now))).toBe(now + 300);
    expect(feeBoundTakeDeadline(now, BigInt(now - 1))).toBe(now + 300);
    expect(feeBoundTakeDeadline(now, BigInt(now + 301))).toBe(now + 300);
  });

  it("makes a quote expiring in the next second unusable before the fee flips", () => {
    expect(feeBoundTakeDeadline(now, BigInt(now + 1))).toBe(now);
  });
});
