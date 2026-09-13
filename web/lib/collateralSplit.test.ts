import { describe, expect, it } from "vitest";

import { collateralSplit, type VaultSnapshot } from "./hooks";

const E18 = 10n ** 18n;

function snap(over: Partial<VaultSnapshot>): VaultSnapshot {
  return { ready: true, fillState: "unknown", ...over } as VaultSnapshot;
}

describe("collateralSplit", () => {
  it("prices each lot from what is still locked, not from every contract written", () => {
    // 14 written, 5 sold, 3 assigned: Valorem has already taken 3 lots, so 11e18 is locked.
    const split = collateralSplit(
      snap({ contractsWritten: 14n, contractsSold: 5n, contractsAssigned: 3n, lockedAssets: 11n * E18, idleAssets: 3n * E18 }),
    );
    expect(split.assigned).toBe(3n * E18);
    expect(split.sold).toBe(5n * E18);
    expect(split.listed).toBe(6n * E18);
  });

  it("before any assignment the lot is locked / written", () => {
    const split = collateralSplit(snap({ contractsWritten: 14n, contractsSold: 0n, lockedAssets: 14n * E18 }));
    expect(split).toMatchObject({ listed: 14n * E18, sold: 0n, assigned: 0n });
  });

  it("falls back to the registry lot when nothing is locked", () => {
    const split = collateralSplit(snap({ contractsWritten: 0n, lockedAssets: 0n, registryLotSize: E18 }));
    expect(split).toMatchObject({ listed: 0n, sold: 0n, assigned: 0n });
  });
});
