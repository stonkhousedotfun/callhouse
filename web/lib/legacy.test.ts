import { describe, expect, it } from "vitest";

import { migrationStep } from "./legacy";

const empty = { listedExpiry: 0n, chainNow: 2_000n, usdg: 0n, idle: 0n, claimKey: 0n };

describe("v1 writer migration order", () => {
  it("waits for chain expiry before enabling settlement", () => {
    expect(migrationStep({ ...empty, listedExpiry: 2_001n })).toBe("wait");
    expect(migrationStep({ ...empty, listedExpiry: 2_000n })).toBe("settle");
    expect(migrationStep({ ...empty, listedExpiry: 2_000n, chainNow: null })).toBe("wait");
  });

  it("claims proceeds and withdraws idle assets before moving to v2", () => {
    expect(migrationStep({ ...empty, usdg: 1n, idle: 1n })).toBe("claim");
    expect(migrationStep({ ...empty, idle: 1n })).toBe("withdraw");
    expect(migrationStep(empty)).toBe("deposit");
  });

  it("keeps a stranded Valorem claim visible", () => {
    expect(migrationStep({ ...empty, claimKey: 1n })).toBe("recovery");
  });
});
