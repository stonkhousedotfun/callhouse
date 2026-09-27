import { describe, expect, it } from "vitest";
import { V2_DEFAULTS } from "../markets.generated";
import { getV2Market } from "../markets";
import { closestDelta, dailyOffered, dailyWeekdaysLabel, dailyWeekdaysOf, expiriesAheadOf, otmBps, visiblePresets, weeklyOffered, presetAutoRollTarget,
  presetStrategy, resolvePresetPricing, retainedSharesAtExpiry, roundAskToTick, writerQuote } from "./presets";
import { selectSmartPricingReference } from "./smartPricing";

describe("writer presets", () => {
  const spot = 200_000_000n;
  it("maps the four visible presets into bounded on-chain strategies", () => {
    const weekly = presetStrategy("weekly-5", spot, 2_000_000n, 25n);
    expect(weekly).toMatchObject({ weekly: true, otmBps: 500, askBps: 100, minAskBps: 50,
      maxAskBps: 300, smartPricing: false, maxUnits: "25" });
    expect(presetStrategy("daily-2", spot, null, 1n).otmBps).toBe(200);
    expect(presetStrategy("weekly-10", spot, null, 1n).otmBps).toBe(1_000);
    expect(presetStrategy("weekly-delta-15", spot, null, 1n, 214_000_000n).otmBps).toBe(700);
    expect(() => presetStrategy("weekly-delta-15", spot, null, 1n)).toThrow(/delta is unavailable/);
  });

  it("keeps an unavailable-reference preset manual instead of silently enabling guessed pricing", () => {
    expect(presetStrategy("daily-2", spot, null, 1n)).toMatchObject({
      smartPricing: false, askBps: 100, minAskBps: 50, maxAskBps: 200,
    });
  });

  it("never persists the proposed smart ceiling as a fixed preset ask", () => {
    const strategy = presetStrategy("weekly-5", 212_210_000n, 3_183_101n, 1n);
    expect(strategy).toMatchObject({ smartPricing: false, askBps: 150 });
    expect(strategy.askBps).toBeLessThan(strategy.maxAskBps);
    expect(() => presetStrategy("weekly-5", 212_210_000n, 21_221_001n, 1n))
      .toThrow(/writer-protective fixed ask/);
  });

  it("selects pricing references against the future contract target, not the nearest manual row", () => {
    const spot = 200_000_000n;
    const currentManualStrike = 211_000_000n;
    const future = presetAutoRollTarget("weekly-delta-15", spot, 2_500_000n, currentManualStrike);
    expect(future).toEqual({ otmBps: 550, strike: 212_500_000n });
    expect(future.strike).not.toBe(currentManualStrike);
    const rows = [
      { id: "manual-nearest", expiry: 100, strike: currentManualStrike, tenor: "weekly" as const, status: "open" },
      { id: "future-reference", expiry: 100, strike: 212_500_000n, tenor: "weekly" as const, status: "open" },
    ];
    expect(selectSmartPricingReference(rows, true, future.strike)?.id).toBe("future-reference");
  });

  it("uses live delta and rejects an out-of-range auto-roll strike", () => {
    const rows = [{ delta: 0.3, strike: 210_000_000n }, { delta: 0.148, strike: 214_000_000n },
      { delta: 0.151, strike: 215_000_000n }, { delta: null, strike: 216_000_000n }];
    expect(closestDelta(rows, spot)).toEqual(rows[2]);
    expect(otmBps(spot, 214_000_000n)).toBe(700);
    expect(() => otmBps(spot, 250_100_000n)).toThrow(/1% to 25%/);
  });

  it("orchestrates a delta preset with one live fair read for the distinct longest-dated reference", async () => {
    const manual = { id: "manual-delta" };
    const reference = { id: "future-reference" };
    const rows = [
      { row: manual, delta: 0.15, fair: 7n, strike: 211_000_000n,
        expiry: 100, tenor: "weekly" as const, status: "open" },
      { row: reference, delta: 0.3, fair: 8n, strike: 212_500_000n,
        expiry: 300, tenor: "weekly" as const, status: "open" },
    ];
    const calls: string[] = [];
    const selected = await resolvePresetPricing("weekly-delta-15", rows, spot, 2_500_000n, async (row) => {
      calls.push(row.id);
      return 9n;
    });
    expect(selected).toEqual({
      target: manual, targetStrike: 211_000_000n, targetFair: 7n,
      reference, referenceFair: 9n, futureRollTarget: 212_500_000n,
    });
    expect(calls).toEqual(["future-reference"]);
  });

  it("keeps the pricing-reference row quote on its sole live fair failure", async () => {
    let calls = 0;
    const snapshot = [{ row: "available", delta: 0.15, fair: 7n, strike: 214_000_000n,
      expiry: 100, tenor: "weekly" as const, status: "open" }];
    await expect(resolvePresetPricing("weekly-delta-15", snapshot, spot, 1_000_000n, async () => {
      calls += 1;
      throw new Error("offline");
    })).resolves.toMatchObject({ target: "available", targetFair: 7n,
      reference: "available", referenceFair: 7n });
    expect(calls).toBe(1);
  });

  it("uses one successful live fair read when the manual and reference rows are the same", async () => {
    let calls = 0;
    const snapshot = [{ row: "same-row", delta: 0.15, fair: 7n, strike: 214_000_000n,
      expiry: 100, tenor: "weekly" as const, status: "open" }];
    await expect(resolvePresetPricing("weekly-delta-15", snapshot, spot, 1_000_000n, async () => {
      calls += 1;
      return 9n;
    })).resolves.toMatchObject({ target: "same-row", targetFair: 9n,
      reference: "same-row", referenceFair: 9n });
    expect(calls).toBe(1);
  });
});

describe("writer quote and outcome", () => {
  it("keeps the launch premium whole with a zero premium fee", () => {
    expect(writerQuote(1_150_000n, 100n, 0, null)).toMatchObject({ gross: 1_150_000n, fee: 0n, net: 1_150_000n });
    // Native collateral accounting remains separate; it cannot be subtracted from USDG blindly.
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

/*
 * (six daily closes, no weekly ladder; registry v2.defaults.expiriesAhead { weekly: 0, daily: 6 }).
 * Whether weeklies are offered is READ from the registry, so these assert against V2_DEFAULTS, not a typed value.
 */
describe("the weekly tenor follows the registry", () => {
  it("offers weeklies exactly when the registry's weekly count is above zero, and today it is not", () => {
    expect(weeklyOffered()).toBe(V2_DEFAULTS.expiriesAhead.weekly > 0);
    expect(V2_DEFAULTS.expiriesAhead.weekly).toBe(0);
    expect(weeklyOffered()).toBe(false);
  });

  it("a market's own override wins over the default, in both directions", () => {
    expect(weeklyOffered({ expiriesAhead: { weekly: 2 } })).toBe(true);
    expect(weeklyOffered({ expiriesAhead: { weekly: 0 } })).toBe(false);
    // No weekly key: the default applies.
    expect(weeklyOffered({ expiriesAhead: { daily: 3 } })).toBe(weeklyOffered());
    expect(weeklyOffered(null)).toBe(weeklyOffered());
  });

  it("hides every weekly preset when weeklies are off, and shows all four when on", () => {
    const off = visiblePresets(false);
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((preset) => !preset.weekly)).toBe(true);
    expect(off.map((preset) => preset.id)).toEqual(["daily-2"]);
    expect(visiblePresets(true)).toHaveLength(4);
  });
});

/*
 * ("List Mon/Wed/Fri only"). NVDA's registry row sets dailyWeekdays; read from the
 * COMPILED registry, so a registry change moves these.
 */
describe("the daily weekdays follow the registry", () => {
  const overridesOf = (ticker: string) => getV2Market(ticker)!.v2.overrides;
  it("NVDA lists Mon/Wed/Fri; SPCX and a row without the key get the default (every weekday)", () => {
    expect(dailyWeekdaysOf(overridesOf("NVDA"))).toEqual(["mon", "wed", "fri"]);
    expect(dailyWeekdaysLabel(overridesOf("NVDA"))).toBe("Mon, Wed and Fri");
    expect(V2_DEFAULTS.dailyWeekdays).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(dailyWeekdaysOf(overridesOf("SPCX"))).toEqual(V2_DEFAULTS.dailyWeekdays);
    expect(dailyWeekdaysLabel(overridesOf("SPCX"))).toBeNull();
    expect(dailyWeekdaysLabel(null)).toBeNull();
    expect(dailyWeekdaysLabel({ dailyWeekdays: ["tue"] })).toBe("Tue");
    // A malformed list is not trusted: the default stands (the builder and the keeper refuse it anyway).
    expect(dailyWeekdaysOf({ dailyWeekdays: ["sun"] })).toEqual(V2_DEFAULTS.dailyWeekdays);
    expect(dailyWeekdaysOf({ dailyWeekdays: [] })).toEqual(V2_DEFAULTS.dailyWeekdays);
  });
});

/*
 * SPCX's registry row sets expiriesAhead
 * { weekly: 2, daily: 0 }. Before this, the "daily-2" preset was always shown and on SPCX could only throw "No open
 * series match that expiry type right now." These read the COMPILED registry, so a registry change moves them.
 */
describe("the daily tenor follows the registry too", () => {
  const overridesOf = (ticker: string) => getV2Market(ticker)!.v2.overrides;

  it("SPCX lists Friday (weekly) expiries and no dailies; NVDA keeps the default dailies", () => {
    expect(expiriesAheadOf(overridesOf("SPCX"))).toEqual({ weekly: 2, daily: 0 });
    expect(dailyOffered(overridesOf("SPCX"))).toBe(false);
    expect(weeklyOffered(overridesOf("SPCX"))).toBe(true);
    expect(expiriesAheadOf(overridesOf("NVDA"))).toEqual(V2_DEFAULTS.expiriesAhead);
    expect(dailyOffered(overridesOf("NVDA"))).toBe(true);
    expect(weeklyOffered(overridesOf("NVDA"))).toBe(false);
  });

  it("a market's own daily count wins over the default, and no daily key falls back to it", () => {
    expect(dailyOffered({ expiriesAhead: { daily: 0 } })).toBe(false);
    expect(dailyOffered({ expiriesAhead: { daily: 3 } })).toBe(true);
    expect(dailyOffered({ expiriesAhead: { weekly: 2 } })).toBe(V2_DEFAULTS.expiriesAhead.daily > 0);
    expect(dailyOffered(null)).toBe(V2_DEFAULTS.expiriesAhead.daily > 0);
  });

  it("hides the daily preset on a market with no dailies: SPCX gets the three weekly presets only", () => {
    const spcx = visiblePresets(weeklyOffered(overridesOf("SPCX")), dailyOffered(overridesOf("SPCX")));
    expect(spcx.map((preset) => preset.id)).toEqual(["weekly-5", "weekly-delta-15", "weekly-10"]);
    expect(spcx.every((preset) => preset.weekly)).toBe(true);
    const nvda = visiblePresets(weeklyOffered(overridesOf("NVDA")), dailyOffered(overridesOf("NVDA")));
    expect(nvda.map((preset) => preset.id)).toEqual(["daily-2"]);
    // The second argument defaults to on, so a caller that predates it keeps its old list.
    expect(visiblePresets(false)).toEqual(visiblePresets(false, true));
  });
});
