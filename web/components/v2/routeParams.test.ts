import { describe, expect, it } from "vitest";

import { ALL_MARKETS } from "@/lib/markets";
import { longIdOf } from "@/lib/v2/seriesId";
import { parseV2Series, parseV2Ticker } from "@/app/v2-route-params";

describe("v2 route params", () => {
  const market = ALL_MARKETS.find((row) => row.ticker === "NVDA")!;

  it("accepts canonical registry ticker slugs only", () => {
    expect(parseV2Ticker("nvda")?.ticker).toBe("NVDA");
    expect(parseV2Ticker("NVDA")).toBeUndefined();
    expect(parseV2Ticker("unknown")).toBeUndefined();
  });

  it("accepts only unsigned, even, nonzero canonical long ids", () => {
    expect(parseV2Series(market, "42")).toBe("42");
    for (const bad of ["0", "3", "042", "-2", "2.0", "2x", "1".repeat(100)]) {
      expect(parseV2Series(market, bad)).toBeUndefined();
    }
  });

  it("resolves call and put aliases at New York close across DST", () => {
    const summer = Date.UTC(2026, 8, 25, 20) / 1000;
    const winter = Date.UTC(2026, 0, 23, 21) / 1000;
    expect(parseV2Series(market, "c-231-2026-09-25")).toBe(longIdOf(market.asset, false, 231_000_000n, summer).toString());
    expect(parseV2Series(market, "p-231.5-2026-01-23")).toBe(longIdOf(market.asset, true, 231_500_000n, winter).toString());
    expect(parseV2Series(market, "c-231-2026-02-30")).toBeUndefined();
  });
});
