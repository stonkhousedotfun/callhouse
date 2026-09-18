import { describe, expect, it } from "vitest";
import { assignedValue, collateralValue, primaryPremiumReceived } from "../../lib/v2/writer";

describe("writer yield accounting", () => {
  it("marks call and put assignment using their collateral asset", () => {
    // Two 0.01-share call units lock 0.02 shares. The writer receives the
    // short payout worth $2 at settlement of $120, losing $0.40 of value.
    expect(collateralValue(2n, 100_000_000n, false)).toBe(2_000_000n);
    expect(assignedValue(2n, 100_000_000n, 120_000_000n, false, 2_000_000n)).toBe(400_000n);
    // A put struck at $100 locks $2; a $90 settlement returns $1.80.
    expect(assignedValue(2n, 100_000_000n, 90_000_000n, true, 1_800_000n)).toBe(200_000n);
  });

  it("counts primary net premium after seller fees and rebates", () => {
    expect(primaryPremiumReceived(1_000_000n, 50_000n, 25_000n, 100_000n, true, false)).toBe(975_000n);
    expect(primaryPremiumReceived(1_000_000n, 50_000n, 0n, 100_000n, false, true)).toBe(850_000n);
  });
});
