import { describe, expect, it } from "vitest";
import { conversionFloorBps } from "./fees";
import { BPS, MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, usdgPayoutBand } from "./payoff";

// The site helper (callhouse-site lib/fees.ts), ported. The worked example is the
// site's (examplePayoff.ts:23, conversionFloorBps(300, 100) = 9_700: the combined cap binds). Every case must agree
// with the app's own band helper (payoff.ts usdgPayoutBand), which mirrors Clearinghouse._conversionFloor.
describe("conversionFloorBps", () => {
  it("is 10_000 minus min(ceiling, slippage + min(route cap, route fee)), and matches usdgPayoutBand.floorBps", () => {
    expect(conversionFloorBps(300, 100)).toBe(9_700);
    expect(conversionFloorBps(0, 0)).toBe(10_000);
    expect(conversionFloorBps(50, 30)).toBe(9_920);
    expect(conversionFloorBps(50, 500)).toBe(9_850); // the route fee clamps to MAX_ROUTE_FEE_BPS first
    expect(conversionFloorBps(250, 100)).toBe(9_700); // then the sum clamps to the ceiling
    for (const slippage of [0, 1, 99, 150, 200, 299, 300]) {
      for (const route of [0, 1, 50, 100, 101, 1_000]) {
        expect(conversionFloorBps(slippage, route)).toBe(usdgPayoutBand(BPS, slippage, route).floorBps);
      }
    }
    expect(MAX_PAYOUT_SLIPPAGE_CEIL_BPS).toBe(300);
    expect(MAX_ROUTE_FEE_BPS).toBe(100);
  });

  it("refuses a slippage above the ceiling, a negative or fractional rate", () => {
    expect(() => conversionFloorBps(301, 0)).toThrow(/conversion bounds/);
    expect(() => conversionFloorBps(-1, 0)).toThrow(/conversion bounds/);
    expect(() => conversionFloorBps(0, -1)).toThrow(/conversion bounds/);
    expect(() => conversionFloorBps(1.5, 0)).toThrow(/conversion bounds/);
  });
});
