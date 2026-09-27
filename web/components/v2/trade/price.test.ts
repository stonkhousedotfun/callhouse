import { describe, expect, it } from "vitest";

import { contractName, expiryName, pctFrom, usd } from "./price";

describe("usd: the option price display rule", () => {
  it("shows exactly two decimals at or above $0.10", () => {
    expect(usd(350_000n)).toBe("$0.35");
    expect(usd(1_200_000n)).toBe("$1.20");
    expect(usd(12_000_000n)).toBe("$12.00");
    expect(usd(100_000n)).toBe("$0.10");
    expect(usd(1_234_500_000n)).toBe("$1,234.50");
  });

  it("shows exactly three decimals under $0.10", () => {
    expect(usd(88_000n)).toBe("$0.088");
    expect(usd(61_000n)).toBe("$0.061");
    expect(usd(20_000n)).toBe("$0.020");
    expect(usd(50_000n)).toBe("$0.050");
    expect(usd(1_000n)).toBe("$0.001");
  });

  it("shows zero as $0.00 and signs a negative with a minus", () => {
    expect(usd(0n)).toBe("$0.00");
    expect(usd(-120_000n)).toBe("−$0.12");
  });

  it("rounds once, in the direction asked, and a sub-dime amount that rounds up to a dime reads as one", () => {
    expect(usd(89_650n)).toBe("$0.090");
    expect(usd(89_450n)).toBe("$0.089");
    expect(usd(89_450n, 6, "up")).toBe("$0.090");
    expect(usd(89_650n, 6, "down")).toBe("$0.089");
    expect(usd(33_700n)).toBe("$0.034");
    expect(usd(100n, 6, "up")).toBe("$0.001");
    expect(usd(100n)).toBe("$0.001");
    expect(usd(100n, 6, "down")).toBe("$0.000");
    expect(usd(354_500n)).toBe("$0.35");
    expect(usd(354_500n, 6, "up")).toBe("$0.36");
    expect(usd(99_999n, 6, "up")).toBe("$0.10");
    expect(usd(99_999n, 6, "down")).toBe("$0.099");
    expect(usd(99_600n)).toBe("$0.10");
  });

  it("reads other decimals", () => {
    expect(usd(35n, 2)).toBe("$0.35");
    expect(usd(5n, 2)).toBe("$0.050");
    expect(usd(350_000_000_000_000_000n, 18)).toBe("$0.35");
  });
});

describe("pctFrom, expiryName, contractName", () => {
  it("gives the signed distance in tenths of a percent", () => {
    expect(pctFrom(235_090_000n, 225_660_000n)).toBe("+4.2%");
    expect(pctFrom(220_000_000n, 225_660_000n)).toBe("−2.5%");
    expect(pctFrom(225_660_000n, 225_660_000n)).toBe("0.0%");
    expect(pctFrom(1n, null)).toBeNull();
    expect(pctFrom(1n, 0n)).toBeNull();
  });

  it("names an expiry by its New York date", () => {
    expect(expiryName(1_790_625_600)).toBe("Mon Sep 28"); // 2026-09-28 16:00 EDT
  });

  it("capitalises the side", () => {
    expect(contractName("$235 call")).toBe("$235 Call");
    expect(contractName("$232.5 put")).toBe("$232.5 Put");
  });
});
