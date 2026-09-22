import { describe, expect, it } from "vitest";
import { autoRollTargetStrike, fixedAskBpsFromReference, formatUsdgTick, parseUsdgTick,
  portfolioPricingStatus, pricingRequestIsCurrent, pricingWriteState, proposedSmartPricingBand,
  refreshSmartPricingRows, selectPortfolioSmartPricingStrategies, selectSmartPricingReference,
  PRICER_READING_MAX_AGE_SECONDS, SMART_PRICING_PRICER_DOWN, SMART_PRICING_PRICER_UNKNOWN,
  SMART_PRICING_REVIEW_MS, smartPricingCandidateState, smartPricingDraft, smartPricingOffer, smartPricingPrices,
  snapStrategyPriceToBps, strategyPriceAtBps } from "./smartPricing";
import type { Market, StrategiesResponse } from "./api-types";

type IndexedStrategy = StrategiesResponse["items"][number];
const usd = (raw: string, formatted = raw) => ({ raw, decimals: 6 as const, formatted });
const indexedStrategy = (overrides: Partial<IndexedStrategy> = {}): IndexedStrategy => ({
  writer: "0x1111111111111111111111111111111111111111",
  underlying: "0x2222222222222222222222222222222222222222",
  ticker: "NVDA",
  strategy: { active: true, weekly: true, smartPricing: true, otmBps: 500,
    askBps: 100, minAskBps: 50, maxAskBps: 200, maxUnits: "100" },
  currentLongId: "1", orderId: "9", expiry: 1_800_086_400,
  lastRolledAt: 1_800_000_000, lastStaleCancelAt: null, staleSpot: null,
  pricing: { currentAsk: usd("2000000", "2"), band: { min: usd("1000000", "1"), max: usd("3000000", "3") },
    lastRepricedAt: 1_800_000_100, lastRepricedPrice: usd("2000000", "2"), repriceCount: 2,
    fair: usd("1750000", "1.75") },
  ...overrides,
});

describe("Portfolio smart-pricing identity and state", () => {
  const market = { ticker: "NVDA", underlying: "0x2222222222222222222222222222222222222222" } as Market;

  it("joins the connected writer and exact market underlying, never a global same-ticker row", () => {
    const exact = indexedStrategy();
    const otherWriter = indexedStrategy({ writer: "0x3333333333333333333333333333333333333333", orderId: "10" });
    const otherUnderlying = indexedStrategy({ underlying: "0x4444444444444444444444444444444444444444", orderId: "11" });
    const manual = indexedStrategy({ orderId: "12", strategy: { ...exact.strategy, smartPricing: false } });
    expect(selectPortfolioSmartPricingStrategies(
      [otherWriter, otherUnderlying, manual, exact], exact.writer, [market])).toEqual([exact]);
  });

  it("distinguishes in-band, both clamp boundaries, withdrawn, no-order, and legacy rows", () => {
    const base = indexedStrategy();
    expect(portfolioPricingStatus(base).kind).toBe("in-band");
    expect(portfolioPricingStatus(indexedStrategy({ pricing: { ...base.pricing!, currentAsk: base.pricing!.band!.min } })).kind)
      .toBe("clamped-minimum");
    expect(portfolioPricingStatus(indexedStrategy({ pricing: { ...base.pricing!, currentAsk: base.pricing!.band!.max } })).kind)
      .toBe("clamped-maximum");
    expect(portfolioPricingStatus(indexedStrategy({ orderId: null, lastStaleCancelAt: 1_800_000_200 })).kind)
      .toBe("withdrawn");
    expect(portfolioPricingStatus(indexedStrategy({ orderId: null, lastStaleCancelAt: null })).kind)
      .toBe("no-live-order");
    expect(portfolioPricingStatus(indexedStrategy({ pricing: undefined })).kind).toBe("legacy");
  });
});

describe("smart-pricing writer band", () => {
  it("uses the longest open expiry before choosing the nearest target strike", () => {
    const rows = [
      { id: "near-perfect", expiry: 100, strike: 210_000_000n, tenor: "weekly" as const, status: "open" },
      { id: "far-low", expiry: 300, strike: 209_000_000n, tenor: "weekly" as const, status: "open" },
      { id: "far-nearest", expiry: 300, strike: 211_000_000n, tenor: "weekly" as const, status: "open" },
      { id: "far-cutoff", expiry: 400, strike: 210_000_000n, tenor: "weekly" as const, status: "cutoff" },
      { id: "daily", expiry: 500, strike: 210_000_000n, tenor: "daily" as const, status: "open" },
    ];
    expect(selectSmartPricingReference(rows, true, 211_500_000n)?.id).toBe("far-nearest");
    expect(selectSmartPricingReference(rows, false, 211_500_000n)?.id).toBe("daily");
  });

  it("fails closed on a refresh error and recovers on a later explicit refresh", async () => {
    let recovered = false;
    let calls = 0;
    const refresh = async () => {
      calls += 1;
      return recovered
        ? { items: ["fresh"], error: null }
        : { items: ["stale-must-not-be-used"], error: new Error("offline") };
    };
    await expect(refreshSmartPricingRows(refresh)).rejects.toThrow(/complete call list could not be refreshed/i);
    recovered = true;
    await expect(refreshSmartPricingRows(refresh)).resolves.toEqual(["fresh"]);
    expect(calls).toBe(2);
  });

  it("builds the proposed wider band and starts at its ceiling", () => {
    expect(proposedSmartPricingBand(200_000_000n, 2_000_000n)).toEqual({
      referenceBps: 100, minAskBps: 25, maxAskBps: 300, askBps: 300,
    });
    expect(proposedSmartPricingBand(200_000_000n, 80_000n)).toEqual({
      referenceBps: 4, minAskBps: 5, maxAskBps: 29, askBps: 29,
    });
    expect(proposedSmartPricingBand(200_000_000n, 50_000_000n)).toEqual({
      referenceBps: 2_500, minAskBps: 625, maxAskBps: 1_000, askBps: 1_000,
    });
    expect(proposedSmartPricingBand(200_000_000n, null)).toBeNull();
  });

  it("shows exact USDG tick limits accepted by the pricer policy", () => {
    expect(smartPricingPrices(212_210_000n, { askBps: 150, minAskBps: 30, maxAskBps: 150 })).toEqual({
      start: 3_183_200n, min: 636_700n, max: 3_183_100n,
    });
    expect(smartPricingPrices(1_000_100n, { askBps: 5, minAskBps: 5, maxAskBps: 5 })).toBeNull();
  });

  it("matches AutoRoller's ceil-then-strike-tick rounding, including coarse ticks", () => {
    expect(autoRollTargetStrike(200_000_001n, 500, 1_000_000n)).toBe(211_000_000n);
    expect(autoRollTargetStrike(200_000_001n, 500, 500_000n)).toBe(210_500_000n);
    expect(autoRollTargetStrike(220_000_000n, 500, 1_000_000n)).toBe(231_000_000n);
    expect(autoRollTargetStrike(200_000_000n, Number.NaN, 1_000_000n)).toBeNull();
    expect(autoRollTargetStrike(200_000_000n, 2_501, 1_000_000n)).toBeNull();
    expect(autoRollTargetStrike(200_000_000n, 500, 0n)).toBeNull();
  });

  it("parses and formats only exact positive 0.0001 USDG ticks", () => {
    expect(parseUsdgTick("3.1832")).toBe(3_183_200n);
    expect(parseUsdgTick("3.1")).toBe(3_100_000n);
    expect(formatUsdgTick(3_100_000n)).toBe("3.1");
    expect(parseUsdgTick("0.00001")).toBeNull();
    expect(parseUsdgTick("0")).toBeNull();
    expect(parseUsdgTick("1e2")).toBeNull();
    expect(parseUsdgTick("1".repeat(33))).toBeNull();
  });

  it("commits typed USDG ticks once with writer-protective integer-bps snapping", () => {
    const spot = 212_210_000n;
    expect(snapStrategyPriceToBps(spot, 3_183_100n, "start")).toEqual({ bps: 150, price: 3_183_200n });
    expect(snapStrategyPriceToBps(spot, 3_162_000n, "maximum")).toEqual({ bps: 150, price: 3_183_100n });
    expect(snapStrategyPriceToBps(spot, 30_000_000n, "start")).toBeNull();

    const committed = snapStrategyPriceToBps(spot, 3_183_100n, "start")!;
    expect(strategyPriceAtBps(220_000_000n, committed.bps, "start")).toBe(3_300_000n);
    expect(fixedAskBpsFromReference(spot, 3_183_100n)).toBe(150);
    expect(fixedAskBpsFromReference(spot, 3_183_101n)).toBe(150);
    expect(strategyPriceAtBps(spot, fixedAskBpsFromReference(spot, 3_183_101n)!, "start"))
      .toBeGreaterThanOrEqual(3_183_101n);
    expect(fixedAskBpsFromReference(spot, 21_221_001n)).toBeNull();
  });

  it("turns a fixed 0/0 strategy into a narrow valid band, or uses the reviewed proposal", () => {
    const spot = 212_210_001n;
    const fixed = smartPricingDraft(spot, { askBps: 100, minAskBps: 0, maxAskBps: 0 }, null);
    expect(fixed).not.toBeNull();
    expect(fixed?.minAskBps).toBeLessThanOrEqual(100);
    expect(fixed?.maxAskBps).toBeGreaterThanOrEqual(100);
    expect(smartPricingPrices(spot, fixed!)).not.toBeNull();

    const proposal = proposedSmartPricingBand(200_000_000n, 2_000_000n)!;
    expect(smartPricingDraft(200_000_000n, { askBps: 100, minAskBps: 0, maxAskBps: 0 }, proposal))
      .toEqual({ askBps: 300, minAskBps: 25, maxAskBps: 300 });
  });

  it("rejects an async pricing result after any form or market input changes", () => {
    const requested = { ticker: "NVDA", underlying: "0xabc", revision: 2,
      spot: 200_000_000n, strikeTick: 1_000_000n,
      weekly: true, otmBps: 500, smartPricing: false };
    expect(pricingRequestIsCurrent(requested, { ...requested })).toBe(true);
    expect(pricingRequestIsCurrent(requested, { ...requested, ticker: "META" })).toBe(false);
    expect(pricingRequestIsCurrent(requested, { ...requested, underlying: "0xdef" })).toBe(false);
    expect(pricingRequestIsCurrent(requested, { ...requested, revision: 3 })).toBe(false);
    expect(pricingRequestIsCurrent(requested, { ...requested, spot: 201_000_000n })).toBe(false);
    expect(pricingRequestIsCurrent(requested, { ...requested, smartPricing: true })).toBe(false);
  });

  it("expires a candidate on a deterministic clock and binds every market/form identity", () => {
    const reviewedAtMs = 10_000;
    const candidate = { ticker: "NVDA", underlying: "0xabc", spot: 200_000_000n,
      strikeTick: 2_500_000n, weekly: true, otmBps: 500, revision: 7, reviewedAtMs };
    const current = { ...candidate };
    expect(smartPricingCandidateState(candidate, current, reviewedAtMs + SMART_PRICING_REVIEW_MS - 1)).toBe("current");
    expect(smartPricingCandidateState(candidate, current, reviewedAtMs + SMART_PRICING_REVIEW_MS)).toBe("expired");
    expect(smartPricingCandidateState(candidate, { ...current, ticker: "META" }, reviewedAtMs)).toBe("changed");
    expect(smartPricingCandidateState(candidate, { ...current, underlying: "0xdef" }, reviewedAtMs)).toBe("changed");
    expect(smartPricingCandidateState(candidate, { ...current, strikeTick: 1_000_000n }, reviewedAtMs)).toBe("changed");
    expect(smartPricingCandidateState(candidate, { ...current, revision: 8 }, reviewedAtMs)).toBe("changed");
  });

  it("fails closed when the reviewed band expires or changes before the strategy write", () => {
    const reviewedAtMs = 10_000;
    const requested = { ticker: "NVDA", underlying: "0xabc", spot: 200_000_000n,
      strikeTick: 2_500_000n, weekly: true, otmBps: 500, revision: 7, smartPricing: true };
    const candidate = { ...requested, reviewedAtMs };
    expect(pricingWriteState(requested, { ...requested }, candidate,
      reviewedAtMs + SMART_PRICING_REVIEW_MS - 1, true)).toBe("current");
    expect(pricingWriteState(requested, { ...requested }, candidate,
      reviewedAtMs + SMART_PRICING_REVIEW_MS, true)).toBe("expired");
    expect(pricingWriteState(requested, { ...requested, spot: 201_000_000n }, candidate,
      reviewedAtMs, true)).toBe("changed");
    expect(pricingWriteState(requested, { ...requested, revision: 8 }, candidate,
      reviewedAtMs, true)).toBe("changed");
    expect(pricingWriteState(requested, { ...requested }, candidate, reviewedAtMs, false)).toBe("changed");
    expect(pricingWriteState(requested, { ...requested }, null,
      reviewedAtMs + SMART_PRICING_REVIEW_MS, true)).toBe("current");
  });
});

/**
 * W3-301: the smart-pricing control is offered only when the pricer is known-healthy.
 *
 * THE ASSERTION THAT MATTERS is not "healthy true means offered" — that one would pass under any
 * implementation, including one that returns `true` unconditionally. It is the ENUMERATION below:
 * every way of not knowing must land on `offered: false`, and the table is written so that adding
 * a new not-knowing state without handling it fails here rather than shipping a control that stays
 * on because its probe broke.
 */
describe("smart pricing is offered only when the pricer is alive", () => {
  const NOW = 1_800_000_000; // unix seconds, matching the wire convention

  it("offered only when a reading exists and says healthy", () => {
    const offer = smartPricingOffer({ healthy: true, reason: "ready", checkedAt: NOW }, NOW);
    expect(offer.offered).toBe(true);
    expect(offer.note).toBe("");
  });

  it("EVERY way of not knowing is not offered", () => {
    // The control. One list, one expectation; a sixth state added without handling fails here.
    const notKnowing: Array<[string, Parameters<typeof smartPricingOffer>[0]]> = [
      ["pending (query has not answered)", undefined],
      ["failed (query threw)", null],
      ["healthy arrived as a non-boolean", { healthy: "yes", reason: "ready", checkedAt: NOW } as never],
      ["checkedAt arrived as a non-number", { healthy: true, reason: "ready", checkedAt: "now" } as never],
      ["checkedAt is not finite", { healthy: true, reason: "ready", checkedAt: Number.NaN }],
      ["reading is older than the max age", { healthy: true, reason: "ready", checkedAt: NOW - PRICER_READING_MAX_AGE_SECONDS - 1 }],
    ];
    for (const [label, reading] of notKnowing) {
      const offer = smartPricingOffer(reading, NOW);
      expect(offer.offered, label).toBe(false);
      expect(offer.note, label).toBe(SMART_PRICING_PRICER_UNKNOWN);
    }
  });

  it("a pricer that says it is NOT ready is a different note from not knowing", () => {
    // Worth distinguishing: "we asked and it said no" is actionable for the user in a way that
    // "we could not ask" is not, and the two must not be collapsed into one vague sentence.
    for (const reason of ["not_ready", "not_configured", "timeout", "http_error", "malformed_body", "stale"]) {
      const offer = smartPricingOffer({ healthy: false, reason, checkedAt: NOW }, NOW);
      expect(offer.offered, reason).toBe(false);
      expect(offer.note, reason).toBe(SMART_PRICING_PRICER_DOWN);
    }
    expect(SMART_PRICING_PRICER_DOWN).not.toBe(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("a reading exactly at the age limit is still current, one second past it is not", () => {
    // The boundary, stated rather than implied, so a later > / >= change is a red test.
    const atLimit = { healthy: true, reason: "ready", checkedAt: NOW - PRICER_READING_MAX_AGE_SECONDS };
    expect(smartPricingOffer(atLimit, NOW).offered).toBe(true);
    const pastLimit = { healthy: true, reason: "ready", checkedAt: NOW - PRICER_READING_MAX_AGE_SECONDS - 1 };
    expect(smartPricingOffer(pastLimit, NOW).offered).toBe(false);
  });

  it("both notes tell the user what still works, because the standing order is unaffected", () => {
    // AC5: this row gates the OFFER, not the live ask. Saying so in the note is the whole reason
    // the sentence is not just "unavailable".
    for (const note of [SMART_PRICING_PRICER_DOWN, SMART_PRICING_PRICER_UNKNOWN]) {
      expect(note).toContain("fixed ask");
      expect(note).toContain("stays live");
    }
  });
});
