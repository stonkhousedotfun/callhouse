import { describe, expect, it } from "vitest";
import { closestDelta, otmBps, presetStrategy, retainedSharesAtExpiry, roundAskToTick, writerQuote } from "./presets";

describe("writer presets", () => {
  const spot = 200_000_000n;
  it("maps the four visible presets into bounded on-chain strategies", () => {
    const weekly = presetStrategy("weekly-5", spot, 2_000_000n, 25n);
    expect(weekly).toMatchObject({ weekly: true, otmBps: 500, askBps: 100, smartPricing: true, maxUnits: "25" });
    expect(presetStrategy("daily-2", spot, null, 1n).otmBps).toBe(200);
    expect(presetStrategy("weekly-10", spot, null, 1n).otmBps).toBe(1_000);
    expect(presetStrategy("weekly-delta-15", spot, null, 1n, 214_000_000n).otmBps).toBe(700);
    expect(() => presetStrategy("weekly-delta-15", spot, null, 1n)).toThrow(/delta is unavailable/);
  });

  it("uses live delta and rejects an out-of-range auto-roll strike", () => {
    const rows = [{ delta: 0.3, strike: 210_000_000n }, { delta: 0.148, strike: 214_000_000n },
      { delta: 0.151, strike: 215_000_000n }, { delta: null, strike: 216_000_000n }];
    expect(closestDelta(rows, spot)).toEqual(rows[2]);
    expect(otmBps(spot, 214_000_000n)).toBe(700);
    expect(() => otmBps(spot, 250_100_000n)).toThrow(/1% to 25%/);
  });
});

describe("writer quote and outcome", () => {
  it("keeps the launch premium whole with a zero premium fee", () => {
    expect(writerQuote(1_150_000n, 100n, 0, null)).toMatchObject({ gross: 1_150_000n, fee: 0n, net: 1_150_000n });
    // Native collateral rent remains a separate figure; it cannot be subtracted from USDG blindly.
  });

  it("shows premium net of a scheduled seller fee without hiding a below-fair ask", () => {
    expect(writerQuote(1_150_000n, 100n, 500, 1_920_000n)).toEqual({
      gross: 1_150_000n, fee: 57_500n, net: 1_092_500n, comparison: "40.1% under fair value",
    });
    expect(writerQuote(2_000_000n, 50n, 500, null).comparison).toBeNull();
  });

  it("values an ITM writer's remaining Stock Tokens at the strike", () => {
    expect(retainedSharesAtExpiry(200_000_000n, 220_000_000n, 100n)).toBeCloseTo(200 / 220, 5);
    expect(retainedSharesAtExpiry(200_000_000n, 190_000_000n, 100n)).toBe(1);
  });

  it("prefills a valid AskWrite price tick from an arbitrary fair value", () => {
    expect(roundAskToTick(2_121_643n)).toBe(2_121_600n);
    expect(roundAskToTick(1n)).toBe(100n);
  });
});
