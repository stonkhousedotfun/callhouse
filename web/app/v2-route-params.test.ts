import { describe, expect, it } from "vitest";

import { v2Markets } from "@/lib/markets";
import { longIdOf } from "@/lib/v2/seriesId";
import { parseV2Series, parseV2Ticker, sellHref } from "./v2-route-params";

const market = v2Markets().find((row) => row.ticker === "NVDA")!;

describe("sellHref", () => {
  it("lowercases the ticker and drops an empty query", () => {
    expect(sellHref("NVDA")).toBe("/sell/nvda");
    expect(sellHref("NVDA", { a: undefined })).toBe("/sell/nvda");
  });

  it("keeps the query string, repeated keys included, and encodes values", () => {
    expect(sellHref("Tsla", { series: "42", tag: ["a", "b c"], skip: undefined })).toBe("/sell/tsla?series=42&tag=a&tag=b+c");
  });
});

describe("parseV2Ticker", () => {
  it("refuses slugs outside the allowed alphabet or length before a registry lookup", () => {
    for (const bad of ["", "nv da", "nvda/", "abcdefghijk", "NVDA", "../x"]) expect(parseV2Ticker(bad)).toBeUndefined();
  });

  it("resolves a well-formed slug through the registry, and misses an unknown one", () => {
    expect(parseV2Ticker("nvda")).toBe(market);
    expect(parseV2Ticker("zzzz")).toBeUndefined();
  });
});

describe("parseV2Series aliases", () => {
  it("accepts up to six strike decimals and pads the fraction to USDG units", () => {
    const expiry = Date.UTC(2026, 8, 25, 20) / 1000;
    expect(parseV2Series(market, "c-231.000001-2026-09-25")).toBe(longIdOf(market.asset, false, 231_000_001n, expiry).toString());
    expect(parseV2Series(market, "p-0.5-2026-09-25")).toBeUndefined(); // strike must start with 1-9
    expect(parseV2Series(market, "c-1.1234567-2026-09-25")).toBeUndefined(); // 7 decimals
  });

  it("rejects malformed sides, dates and year zero", () => {
    for (const bad of ["x-231-2026-09-25", "c-231-26-09-25", "c-231-2026-13-01", "c-231-0000-01-01", "C-231-2026-09-25", "c-231"]) {
      expect(parseV2Series(market, bad)).toBeUndefined();
    }
  });

  it("returns undefined instead of throwing when the strike exceeds uint128", () => {
    expect(parseV2Series(market, `c-${"9".repeat(40)}-2026-09-25`)).toBeUndefined();
  });

  it("refuses an id at or above 2^256", () => {
    expect(parseV2Series(market, (2n ** 256n).toString())).toBeUndefined();
    expect(parseV2Series(market, (2n ** 256n - 2n).toString())).toBe((2n ** 256n - 2n).toString());
  });
});
