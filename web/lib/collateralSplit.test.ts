import { describe, expect, it } from "vitest";

import { collateralSplit, type VaultSnapshot } from "./hooks";

const E18 = 10n ** 18n;

function snap(over: Partial<VaultSnapshot>): VaultSnapshot {
  return { ready: true, spotStale: false, ...over } as VaultSnapshot;
}

describe("collateralSplit", () => {
  it("has no 'listed, unsold' slice: everything locked was sold in the transaction that wrote it", () => {
    // 5 sold this week (written inside the fills), 3 assigned: Valorem has already taken 3 lots,
    // so 2e18 is still locked and every lot of it is a sold call.
    const split = collateralSplit(snap({ contractsWritten: 5n, contractsAssigned: 3n, lockedAssets: 2n * E18, idleAssets: 20n * E18 }));
    expect(split).toEqual({ idle: 20n * E18, sold: 2n * E18, assigned: 3n * E18 });
    expect("listed" in split).toBe(false);
  });

  it("before any assignment the sold slice is everything locked", () => {
    const split = collateralSplit(snap({ contractsWritten: 14n, lockedAssets: 14n * E18, idleAssets: 6n * E18 }));
    expect(split).toEqual({ idle: 6n * E18, sold: 14n * E18, assigned: 0n });
  });

  it("is all idle while flat, and idle is unknown until read", () => {
    expect(collateralSplit(snap({ contractsWritten: 0n, lockedAssets: 0n, idleAssets: 25n * E18 }))).toEqual({
      idle: 25n * E18,
      sold: 0n,
      assigned: 0n,
    });
    expect(collateralSplit(snap({}))).toEqual({ idle: undefined, sold: 0n, assigned: 0n });
  });
});
