import { describe, expect, it } from "vitest";

import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, costToBuy } from "./payoff";
import {
  bandText, buildPayoffReceipt, formatMultiple, formatNative, formatPct, formatPriceExact, formatSignedUsdg, formatTokens,
  formatUsdgCents, pnlRangeText, scenarioFigures,
} from "./payoffReceipt";

/** The design example (docs/product/TRADE-PAYOFF-EXPLORER.md §2.5), recomputed in base units by payoff.test.ts:
 * 300 units at 4.1333 USDG/share, strike 230, exercise fee 25 bps, settlement 240, conversion at the ceiling. */
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const quote = costToBuy([{ orderId: "1", price: 4_133_300n, units: 300n }], 300n, fees);
const call = { isPut: false, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
const put = { isPut: true, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
const ceiling = { slippageBps: MAX_PAYOUT_SLIPPAGE_CEIL_BPS, routeFeeBps: MAX_ROUTE_FEE_BPS };

describe("receipt formatting follows the rounding rule", () => {
  it("rounds costs up, payouts down, and a loss away from zero", () => {
    expect(formatUsdgCents(12_499_900n, "up")).toBe("12.50");
    expect(formatUsdgCents(12_499_900n, "down")).toBe("12.49");
    expect(formatUsdgCents(-12_499_900n, "down")).toBe("−12.50");
    expect(formatUsdgCents(1_234_567_890n, "down")).toBe("1,234.56");
    expect(formatSignedUsdg(15_699_800n)).toBe("+15.69");
    expect(formatSignedUsdg(0n)).toBe("0.00");
    expect(formatSignedUsdg(-1n)).toBe("−0.01");
  });

  it("shows prices exactly, tokens to six floored places and percentages as whole floors", () => {
    expect(formatPriceExact(234_772_778n)).toBe("234.772778");
    expect(formatPriceExact(240_000_000n)).toBe("240.00");
    expect(formatTokens(117_499_999_999_999_800n)).toBe("0.117499");
    expect(formatTokens(10n ** 18n)).toBe("1.000000");
    expect(() => formatTokens(-1n)).toThrow();
    expect(formatPct(125.59)).toBe("+125 %");
    expect(formatPct(-0.01)).toBe("−1 %");
    expect(formatPct(0)).toBe("0 %");
    expect(formatPct(null)).toBe("—");
    expect(formatMultiple(2.25)).toBe("2.25×");
    expect(formatMultiple(null)).toBe("—");
    expect(formatNative(12_345_678_901_234n, "ETH")).toBe("0.000012 ETH");
  });
});

describe("scenario figures", () => {
  it("bands a call between the conversion floor and the in-kind value", () => {
    const figures = scenarioFigures(call, quote.cost, 240_000_000n, ceiling);
    expect(figures).toMatchObject({
      price: 240_000_000n, grossPerUnit: 416_666_666_666_666n, feePerUnit: 25_000_000_000_000n, netPerUnit: 391_666_666_666_666n,
      netTotal: 117_499_999_999_999_800n, payoutValue: 28_199_700n,
      band: { low: 27_353_709n, high: 28_199_700n, floorBps: 9_700 },
      pnlHigh: { pnl: 15_699_800n, pct: 125.59, multiple: 2.25 },
      pnlLow: { pnl: 14_853_809n, pct: 118.83, multiple: 2.18 },
    });
    expect(bandText(figures.band!)).toBe("between 27.35 and 28.19 USDG");
    expect(pnlRangeText(figures.pnlLow, figures.pnlHigh)).toBe("+14.85 to +15.69 USDG (+118 % to +125 %, 2.18× to 2.25×)");
  });

  it("gives a put one figure: USDG, no band", () => {
    const figures = scenarioFigures(put, quote.cost, 220_000_000n, ceiling);
    expect(figures.band).toBeNull();
    expect(figures.grossPerUnit).toBe(100_000n);
    expect(figures.feePerUnit).toBe(5_750n);
    expect(figures.netTotal).toBe(28_275_000n);
    expect(figures.payoutValue).toBe(28_275_000n);
    expect(figures.pnlLow).toEqual(figures.pnlHigh);
    expect(pnlRangeText(figures.pnlLow, figures.pnlHigh)).toBe("+15.77 USDG (+126 %, 2.26×)");
  });

  it("collapses the band when nothing is paid or the payout is zero", () => {
    const figures = scenarioFigures(call, quote.cost, 200_000_000n, ceiling);
    expect(figures.band).toEqual({ low: 0n, high: 0n, floorBps: 9_700 });
    expect(bandText(figures.band!)).toBe("0.00 USDG");
    expect(figures.pnlLow).toEqual({ pnl: -12_499_900n, pct: -100, multiple: 0 });
    const free = scenarioFigures(call, 0n, 240_000_000n, ceiling);
    expect(free.pnlLow).toEqual({ pnl: 27_353_709n, pct: null, multiple: null });
  });
});

describe("the receipt", () => {
  it("renders the design example call, line by line, with every rule attached", () => {
    const receipt = buildPayoffReceipt({ ticker: "NVDA", position: call, cost: quote, fees, price: 240_000_000n, terms: ceiling, gas: null });
    expect(receipt.pay.title).toBe("What you pay now");
    expect(receipt.pay.lines.map((line) => [line.key, line.value, line.note])).toEqual([
      ["premium", "12.40 USDG", "300 × 0.01-share units at 4.1333 USDG/share average ask"],
      ["takerFee", "0.10 USDG", "the lesser of 0.10 USDG or 10 % of premium (1.24)"],
      ["gas", "shown by your wallet", "1 transaction now, plus an approval if your USDG allowance is short (wallet estimate)"],
    ]);
    expect(receipt.pay.total).toMatchObject({ key: "maxLoss", label: "Total = your max loss", value: "12.50 USDG" });
    expect(receipt.get.title).toBe("What you can get at settlement (if NVDA ends at $240.00; strike 230.00 call)");
    expect(receipt.get.lines.map((line) => [line.key, line.value, line.note, line.deduction ?? false])).toEqual([
      ["gross", "0.124999 NVDA", "3 shares × (240.00 − 230.00) ÷ 240.00", false],
      ["exerciseFee", "0.007500 NVDA", "0.25 % of the 3 shares locked, never more than 10 % of the payout", true],
      ["net", "0.117499 NVDA", "gross − exercise fee, in Stock Tokens", false],
      ["asUsdg", "between 27.35 and 28.19 USDG", "worth 28.19 at the settlement price; at worst about 3 % under it (the contract ceiling), or the tokens themselves", false],
      ["redeemGas", "usually paid by a keeper", "if you redeem yourself, 1 transaction", false],
    ]);
    expect(receipt.get.total.value).toBe("+14.85 to +15.69 USDG (+118 % to +125 %, 2.18× to 2.25×)");
    expect(receipt.summary).toBe("Total 12.50 USDG · at $240.00: +14.85 to +15.69 USDG");
    for (const line of [...receipt.pay.lines, receipt.pay.total, ...receipt.get.lines, receipt.get.total]) {
      expect(line.rule.length, line.key).toBeGreaterThan(40);
    }
    // The rules carry the settlement window and the payout form, never a file path.
    const rules = [...receipt.get.lines, receipt.get.total].map((line) => line.rule).join(" ");
    expect(rules).toContain("never more than 10 % of the gross payout");
    expect(rules).toContain("hands you the tokens if that is not possible");
    expect(rules).not.toMatch(/\.sol|\.ts\b/);
  });

  it("renders a put with one USDG figure, the collateral the fee is charged on, and a wallet gas estimate", () => {
    const gas = { transactions: 2, wei: 21_000_000_000_000n, symbol: "ETH" };
    const receipt = buildPayoffReceipt({ ticker: "NVDA", position: put, cost: quote, fees, price: 220_000_000n, terms: ceiling, gas });
    expect(receipt.pay.lines[2]).toMatchObject({ key: "gas", value: "≈ 0.000021 ETH", note: "2 transactions now (wallet estimate)" });
    expect(receipt.get.title).toBe("What you can get at settlement (if NVDA ends at $220.00; strike 230.00 put)");
    expect(receipt.get.lines.map((line) => [line.key, line.value, line.note])).toEqual([
      ["gross", "30.00 USDG", "3 shares × (230.00 − 220.00)"],
      ["exerciseFee", "1.73 USDG", "0.25 % of the 690.00 USDG locked, never more than 10 % of the payout"],
      ["net", "28.27 USDG", "gross − exercise fee"],
      ["paid", "USDG", "to your wallet at redemption"],
      ["redeemGas", "usually paid by a keeper", "if you redeem yourself, 1 transaction"],
    ]);
    expect(receipt.get.total.value).toBe("+15.77 USDG (+126 %, 2.26×)");
    expect(receipt.summary).toBe("Total 12.50 USDG · at $220.00: +15.77 USDG");
  });

  it("says plainly when the option pays nothing at the chosen price", () => {
    const receipt = buildPayoffReceipt({ ticker: "NVDA", position: call, cost: quote, fees, price: 200_000_000n, terms: ceiling, gas: { transactions: 1, wei: null, symbol: "ETH" } });
    expect(receipt.pay.lines[2]).toMatchObject({ value: "shown by your wallet", note: "1 transaction now (wallet estimate)" });
    expect(receipt.get.lines[0]).toMatchObject({ value: "0.000000 NVDA", note: "200.00 is not above the 230.00 strike, so the call pays nothing" });
    expect(receipt.get.total.value).toBe("−12.50 USDG (−100 %, 0.00×)");
    const putReceipt = buildPayoffReceipt({ ticker: "NVDA", position: put, cost: quote, fees, price: 240_000_000n, terms: ceiling, gas: null });
    expect(putReceipt.get.lines[0]).toMatchObject({ value: "0.00 USDG", note: "240.00 is not below the 230.00 strike, so the put pays nothing" });
  });

  it("refuses a quote whose fill differs from the position it describes", () => {
    expect(() => buildPayoffReceipt({ ticker: "NVDA", position: { ...call, units: 299n }, cost: quote, fees, price: 240_000_000n, terms: ceiling, gas: null })).toThrow(RangeError);
    expect(() => buildPayoffReceipt({ ticker: "NVDA", position: call, cost: quote, fees, price: -1n, terms: ceiling, gas: null })).toThrow(RangeError);
  });
});
