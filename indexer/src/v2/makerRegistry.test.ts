import { describe, expect, it } from "vitest";

import { makerRegistryAbi } from "../../abis/v2/makerRegistry";
import { makerEpoch, makerEpochId, reduceTier } from "../../lib/v2/makerRegistry";

describe("MakerRegistry tier reduction", () => {
  it("includes the indexed maker registry event", () => {
    expect(makerRegistryAbi.filter((item) => item.type === "event").map((item) => item.name))
      .toEqual(expect.arrayContaining(["TierSet"]));
  });

  it("keys reward epochs at Monday midnight UTC across New York DST changes", () => {
    expect(makerEpoch(BigInt(Date.parse("2026-03-09T12:00:00Z") / 1000)))
      .toBe(BigInt(Date.parse("2026-03-09T00:00:00Z") / 1000));
    expect(makerEpoch(BigInt(Date.parse("2026-11-02T12:00:00Z") / 1000)))
      .toBe(BigInt(Date.parse("2026-11-02T00:00:00Z") / 1000));
    expect(makerEpoch(BigInt(Date.parse("2026-03-15T03:00:00Z") / 1000)))
      .toBe(BigInt(Date.parse("2026-03-09T00:00:00Z") / 1000));
  });

  it("stores explicit default-tier zero and normalized maker keys", () => {
    expect(reduceTier(60, 0)).toBe(0);
    expect(makerEpochId("0xAB" as `0x${string}`, 123n)).toBe("0xab-123");
  });
});
