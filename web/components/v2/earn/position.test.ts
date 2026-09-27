import { describe, expect, it } from "vitest";

import { hasEarnPosition, type EarnPositionFacts } from "./position";

const EMPTY: EarnPositionFacts = { free: 0n, locked: 0n, autoRollActive: false, lifetimePremium: 0n,
  balanceUnreadable: false, rollUnreadable: false };

describe("when the Earn page shows Your position", () => {
  it("an empty wallet has no position card", () => {
    expect(hasEarnPosition(EMPTY)).toBe(false);
  });

  it("reads that have not answered count as nothing, not as a position", () => {
    expect(hasEarnPosition({ ...EMPTY, free: null, locked: null, lifetimePremium: null })).toBe(false);
  });

  it("any one holding shows it: free, locked, an active auto-roll, or premium already earned", () => {
    expect(hasEarnPosition({ ...EMPTY, free: 1n })).toBe(true);
    expect(hasEarnPosition({ ...EMPTY, locked: 1n })).toBe(true);
    expect(hasEarnPosition({ ...EMPTY, autoRollActive: true })).toBe(true);
    expect(hasEarnPosition({ ...EMPTY, lifetimePremium: 1n })).toBe(true);
  });

  it("a failed balance or roll read shows it, so Withdraw and Pause are never hidden by an error", () => {
    expect(hasEarnPosition({ ...EMPTY, free: null, balanceUnreadable: true })).toBe(true);
    expect(hasEarnPosition({ ...EMPTY, rollUnreadable: true })).toBe(true);
  });
});
