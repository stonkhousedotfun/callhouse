/**
 * lib/numberFormat.ts: the display rules behind fmtUsdg / fmtAsset / fmtShares / the percent formatters.
 * Every expectation is a literal typed from the display rules ("$12 not $12.00", "$1.2M, 12.5K", "<$0.01", at most 4
 * decimals on shares, 1 on percentages, never "0.000000"), not a value read back from the code under test.
 */
import { describe, expect, it } from "vitest";

import {
  COMPACT_FROM, displayExact, displayMoney, displayPercent, displayPrice, displayQuantity, displayRatioPercent, withDollar,
} from "./numberFormat";

const usdg = (text: string): bigint => {
  const [w, f = ""] = text.split(".");
  return BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
};
const e18 = (text: string): bigint => {
  const [w, f = ""] = text.split(".");
  return BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
};

describe("money: at most 2 decimals, none when whole", () => {
  it("drops the cents only when they are zero", () => {
    expect(displayMoney(usdg("12"), 6)).toBe("12");
    expect(displayMoney(usdg("12.3"), 6)).toBe("12.30");
    expect(displayMoney(usdg("12.345678"), 6)).toBe("12.34");
    expect(displayMoney(usdg("0.05"), 6)).toBe("0.05");
    expect(displayMoney(usdg("9999.99"), 6)).toBe("9,999.99");
    expect(displayMoney(0n, 6)).toBe("0");
  });

  it("is compact from 10,000: K, M, B, one decimal, truncated", () => {
    expect(COMPACT_FROM).toBe(10_000n);
    expect(displayMoney(usdg("10000"), 6)).toBe("10K");
    expect(displayMoney(usdg("12549.99"), 6)).toBe("12.5K");
    expect(displayMoney(usdg("250000"), 6)).toBe("250K");
    expect(displayMoney(usdg("999999.99"), 6)).toBe("999.9K");
    expect(displayMoney(usdg("1250000"), 6)).toBe("1.2M");
    expect(displayMoney(usdg("3000000000"), 6)).toBe("3B");
  });

  it("shows a tiny amount as <0.01, never zeros and never 0", () => {
    expect(displayMoney(1n, 6)).toBe("<0.01");
    expect(displayMoney(usdg("0.009999"), 6)).toBe("<0.01");
    expect(displayMoney(-1n, 6)).toBe("-<0.01");
  });

  it("with more decimals for a per-share figure: trailing zeros go, the cents stay", () => {
    expect(displayMoney(usdg("0.04332"), 6, { maxDecimals: 6 })).toBe("0.04332");
    expect(displayMoney(usdg("1.5"), 6, { maxDecimals: 6 })).toBe("1.50");
    expect(displayMoney(usdg("7"), 6, { maxDecimals: 6 })).toBe("7");
    expect(displayMoney(usdg("0.000123"), 6, { maxDecimals: 6 })).toBe("0.000123");
    expect(displayMoney(usdg("0.00005"), 6, { maxDecimals: 6 })).toBe("<0.0001");
    expect(displayMoney(1n, 6, { maxDecimals: 6 })).toBe("<0.0001");
  });

  it("keeps the sign, with the caller's minus", () => {
    expect(displayMoney(-usdg("12.5"), 6)).toBe("-12.50");
    expect(displayMoney(-usdg("25000"), 6, { minus: "−" })).toBe("−25K");
  });
});

describe("price: 2 decimals where prices are compared", () => {
  it("keeps 2 decimals at 1 and up, whole or not, and never compacts", () => {
    expect(displayPrice(usdg("12"), 6)).toBe("12.00");
    expect(displayPrice(usdg("11.95"), 6)).toBe("11.95");
    expect(displayPrice(usdg("123456.789"), 6)).toBe("123,456.78");
  });

  it("shows 3 significant digits under 1, at least 2 decimals, and <0.0001 below", () => {
    expect(displayPrice(usdg("0.5"), 6)).toBe("0.50");
    expect(displayPrice(usdg("0.012345"), 6)).toBe("0.0123");
    expect(displayPrice(usdg("0.000123"), 6)).toBe("0.000123");
    expect(displayPrice(e18("0.00001"), 18)).toBe("<0.0001");
    expect(displayPrice(0n, 6)).toBe("0.00");
  });
});

describe("quantity: shares and units, at most 4 decimals", () => {
  it("drops trailing zeros and truncates", () => {
    expect(displayQuantity(e18("1"), 18)).toBe("1");
    expect(displayQuantity(e18("2.5"), 18)).toBe("2.5");
    expect(displayQuantity(e18("0.123456"), 18)).toBe("0.1234");
    expect(displayQuantity(e18("0.0012"), 18)).toBe("0.0012");
    expect(displayQuantity(e18("12345.6789"), 18)).toBe("12.3K");
    expect(displayQuantity(0n, 18)).toBe("0");
  });

  it("shows below one step as <0.0001", () => {
    expect(displayQuantity(1n, 18)).toBe("<0.0001");
    expect(displayQuantity(e18("0.00009"), 18)).toBe("<0.0001");
  });
});

describe("percent: at most 1 decimal", () => {
  it("from a ratio, exactly", () => {
    expect(displayRatioPercent(1n, 4n)).toBe("25%");
    expect(displayRatioPercent(125n, 1000n)).toBe("12.5%");
    expect(displayRatioPercent(1234n, 10000n)).toBe("12.3%");
    expect(displayRatioPercent(0n, 7n)).toBe("0%");
    expect(displayRatioPercent(1n, 100_000n)).toBe("<0.1%");
    expect(displayRatioPercent(-1n, 8n)).toBe("-12.5%");
    expect(() => displayRatioPercent(1n, 0n)).toThrow(RangeError);
  });

  it("from a number, without a float truncating 2.3 to 2.2", () => {
    expect(displayPercent(2.3)).toBe("2.3%");
    expect(displayPercent(12.34)).toBe("12.3%");
    expect(displayPercent(40)).toBe("40%");
    expect(displayPercent(0.04)).toBe("<0.1%");
    expect(displayPercent(Number.NaN)).toBe("—");
  });
});

describe("never a run of zeros", () => {
  it("no rule prints 0.000000 or a trailing .00 on money", () => {
    const outs = [
      displayMoney(0n, 6), displayMoney(1n, 6), displayMoney(usdg("5"), 6), displayMoney(1n, 6, { maxDecimals: 6 }),
      displayQuantity(0n, 18), displayQuantity(1n, 18), displayQuantity(e18("3"), 18),
      displayPrice(1n, 18), displayRatioPercent(0n, 1n), displayRatioPercent(1n, 10n ** 9n),
    ];
    for (const o of outs) {
      expect(o).not.toMatch(/0\.0{4,}/);
      expect(o).not.toMatch(/\.0+$/);
    }
  });
});

describe("exact: every digit, no zero tail", () => {
  it("keeps every significant digit and at least the cents, with no floor and no compaction", () => {
    expect(displayExact(usdg("3"), 6)).toBe("3.00");
    expect(displayExact(usdg("222.5"), 6)).toBe("222.50");
    expect(displayExact(usdg("0.123456"), 6)).toBe("0.123456");
    expect(displayExact(1n, 6)).toBe("0.000001");
    expect(displayExact(usdg("1234567.8901"), 6)).toBe("1,234,567.8901");
    expect(displayExact(-usdg("3"), 6)).toBe("-3.00");
    expect(displayExact(0n, 6)).toBe("0.00");
    expect(displayExact(e18("2.5"), 18, { minDecimals: 0 })).toBe("2.5");
  });
});

describe("withDollar", () => {
  it("puts the $ after the sign and the <", () => {
    expect(withDollar("12")).toBe("$12");
    expect(withDollar("<0.01")).toBe("<$0.01");
    expect(withDollar("-5")).toBe("-$5");
    expect(withDollar("−<0.01")).toBe("−<$0.01");
    expect(withDollar("1.2M")).toBe("$1.2M");
    expect(withDollar("—")).toBe("—");
  });
});
