import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CYCLE_TERMS_LABELS,
  cycleTerms,
  keeperPricingFigures,
  protocolFeeOn,
  type CycleTermsInput,
  type KeeperPricingFigures,
} from "./cycleTerms";
import type { PolicyBps } from "./format";

/**
 * This cycle's terms as figures. The deadlines are the chain's (the Friday close and +24h), the
 * fee is policy's and floored like Policy.splitHarvest, and the fillable count is the caller's
 * Seaport figure, never the keeper row's. The keeper's pricing report is checked against records
 * the keeper itself produces (planWeek / priceListing on its Cboe fixture), not a guessed shape.
 */

const POLICY: PolicyBps = {
  minOtmBps: 300,
  maxOtmBps: 1200,
  minPremiumBps: 5,
  maxUtilizationBps: 9000,
  protocolFeeBps: 500,
  maxContractsCap: 1000n,
};

// 2026-09-18 16:00 EDT (20:00 UTC) and a day later.
const SEP_EXERCISE = 1789761600;
const SEP_EXPIRY = 1789848000;

function armed(overrides: Partial<CycleTermsInput> = {}): CycleTermsInput {
  return {
    phase: 1,
    cycleStrikeUsdg: 222_000_000n,
    cycleExerciseTs: SEP_EXERCISE,
    cycleExpiryTs: SEP_EXPIRY,
    spotUsdg: 212_345_678n,
    listingGrossUsdg: 23n * 414_137n,
    listingAmount: 23n,
    contractsWritten: 6n,
    capacity: 40n,
    policy: POLICY,
    ...overrides,
  };
}

describe("cycleTerms: nothing armed is null", () => {
  it.each([
    ["phase unread", { phase: undefined }],
    ["Idle", { phase: 0 }],
    ["phase above Settling", { phase: 4 }],
    ["phase 7", { phase: 7 }],
    ["phase negative", { phase: -1 }],
    ["phase NaN", { phase: Number.NaN }],
    ["phase fractional", { phase: 1.5 }],
    ["strike zero", { cycleStrikeUsdg: 0n }],
    ["strike unread", { cycleStrikeUsdg: undefined }],
    ["exercise zero", { cycleExerciseTs: 0 }],
    ["expiry unread", { cycleExpiryTs: undefined }],
  ] as const)("%s", (_label, overrides) => {
    expect(cycleTerms(armed(overrides as Partial<CycleTermsInput>), { fillableContracts: 17n })).toBeNull();
  });

  it("is not null in Exercisable or Settling: the strike and deadlines still stand", () => {
    expect(cycleTerms(armed({ phase: 2 }))?.phase).toBe(2);
    expect(cycleTerms(armed({ phase: 3 }))?.strikeUsdg).toBe(222_000_000n);
  });
});

describe("cycleTerms: an armed week", () => {
  it("with spot: strike, spot, the USDG distance, both deadlines in UTC and Eastern", () => {
    const t = cycleTerms(armed(), { fillableContracts: 17n })!;
    expect(t).not.toBeNull();
    expect(t.strikeUsdg).toBe(222_000_000n);
    expect(t.strikeFmt).toBe("222.00");
    expect(t.spotUsdg).toBe(212_345_678n);
    expect(t.spotFmt).toBe("212.345678");
    expect(t.strikeAboveSpotUsdg).toBe(9_654_322n);
    expect(t.strikeAboveSpotFmt).toBe("9.654322");
    expect(t.exerciseTs).toBe(SEP_EXERCISE);
    expect(t.exerciseUtc).toBe("2026-09-18 20:00 UTC");
    expect(t.exerciseEastern).toBe("2026-09-18 16:00 EDT");
    expect(t.expiryTs).toBe(SEP_EXPIRY);
    expect(t.expiryUtc).toBe("2026-09-19 20:00 UTC");
    expect(t.expiryEastern).toBe("2026-09-19 16:00 EDT");
    expect(t.contractsSold).toBe(6n);
    expect(t.contractsSoldFmt).toBe("6");
    expect(t.fillableContracts).toBe(17n);
    expect(t.fillableContractsFmt).toBe("17");
    expect(t.feeBps).toBe(500);
  });

  it("strike, spot and the distance subtract on screen, digit for digit", () => {
    for (const spotUsdg of [212_345_678n, 212_340_000n, 199_999_999n, 222_000_001n]) {
      const t = cycleTerms(armed({ spotUsdg }))!;
      const asNumber = (s: string) => Math.round(Number(s) * 1e6);
      expect(asNumber(t.strikeFmt) - asNumber(t.spotFmt)).toBe(asNumber(t.strikeAboveSpotFmt));
    }
  });

  it("without spot (a stale feed reverts spotUsdg): distance is a dash, everything else stands", () => {
    const t = cycleTerms(armed({ spotUsdg: undefined }), { fillableContracts: 17n })!;
    expect(t.spotUsdg).toBeUndefined();
    expect(t.spotFmt).toBe("—");
    expect(t.strikeAboveSpotUsdg).toBeUndefined();
    expect(t.strikeAboveSpotFmt).toBe("—");
    expect(t.strikeFmt).toBe("222.00");
    expect(t.exerciseEastern).toBe("2026-09-18 16:00 EDT");
    expect(t.orderGrossIfAllFill6).toBe(17n * 414_137n);
  });

  it("spot above the strike is a negative distance, not a dash", () => {
    const t = cycleTerms(armed({ spotUsdg: 225_000_000n }))!;
    expect(t.strikeAboveSpotUsdg).toBe(-3_000_000n);
    expect(t.strikeAboveSpotFmt).toBe("-3.00");
  });

  it("shows a strike with sub-cent base units exactly rather than truncating it", () => {
    expect(cycleTerms(armed({ cycleStrikeUsdg: 222_500_001n }))!.strikeFmt).toBe("222.500001");
  });

  it("deadlines across the end of daylight time: the Eastern hour holds, the UTC hour moves", () => {
    // Friday 2026-10-30 close, still EDT (daylight time ends Sunday 2026-11-01).
    const before = cycleTerms(armed({ cycleExerciseTs: 1793390400, cycleExpiryTs: 1793476800 }))!;
    expect(before.exerciseUtc).toBe("2026-10-30 20:00 UTC");
    expect(before.exerciseEastern).toBe("2026-10-30 16:00 EDT");
    expect(before.expiryUtc).toBe("2026-10-31 20:00 UTC");
    expect(before.expiryEastern).toBe("2026-10-31 16:00 EDT");
    // Friday 2026-11-06 close, EST.
    const after = cycleTerms(armed({ cycleExerciseTs: 1793998800, cycleExpiryTs: 1794085200 }))!;
    expect(after.exerciseUtc).toBe("2026-11-06 21:00 UTC");
    expect(after.exerciseEastern).toBe("2026-11-06 16:00 EST");
    expect(after.expiryUtc).toBe("2026-11-07 21:00 UTC");
    expect(after.expiryEastern).toBe("2026-11-07 16:00 EST");
  });
});

describe("cycleTerms: the order if every fillable contract sells", () => {
  it("gross and fee are exact bigints with the fee floored; there is no after-fee figure", () => {
    const t = cycleTerms(armed(), { fillableContracts: 17n })!;
    expect(t.unitPrice6).toBe(414_137n);
    expect(t.unitPriceFmt).toBe("0.414137");
    // 17 × 414137 = 7,040,329; × 500 / 10000 = 352,016.45 → 352,016.
    expect(t.orderGrossIfAllFill6).toBe(7_040_329n);
    expect(t.orderFeeIfAllFill6).toBe(352_016n);
    expect(t.orderGrossIfAllFillFmt).toBe("7.040329");
    expect(t.orderFeeIfAllFillFmt).toBe("0.352016");
    expect(Object.keys(t).some((k) => /afterfee/i.test(k))).toBe(false);
  });

  it("whole-cent figures show two decimals", () => {
    const t = cycleTerms(armed({ listingGrossUsdg: 4_000_000n, listingAmount: 4n }), { fillableContracts: 3n })!;
    expect(t.unitPriceFmt).toBe("1.00");
    expect(t.orderGrossIfAllFillFmt).toBe("3.00");
    expect(t.orderFeeIfAllFill6).toBe(150_000n);
    expect(t.orderFeeIfAllFillFmt).toBe("0.15");
  });

  it("fillable 0 is an exact zero order, not a dash", () => {
    const t = cycleTerms(armed(), { fillableContracts: 0n })!;
    expect(t.fillableContracts).toBe(0n);
    expect(t.fillableContractsFmt).toBe("0");
    expect(t.orderGrossIfAllFill6).toBe(0n);
    expect(t.orderFeeIfAllFill6).toBe(0n);
    expect(t.orderGrossIfAllFillFmt).toBe("0.00");
  });

  it("no fillable figure from the caller: no order figures (the keeper row is never consulted)", () => {
    const t = cycleTerms(armed())!;
    expect(t.fillableContracts).toBeUndefined();
    expect(t.fillableContractsFmt).toBe("—");
    expect(t.orderGrossIfAllFill6).toBeUndefined();
    expect(t.orderFeeIfAllFillFmt).toBe("—");
  });

  it("caps the caller's figure at the vault's capacity", () => {
    const t = cycleTerms(armed({ capacity: 12n }), { fillableContracts: 20n })!;
    expect(t.fillableContracts).toBe(12n);
    expect(t.orderGrossIfAllFill6).toBe(12n * 414_137n);
  });

  it("caps the caller's figure at the listing's own size: never more than the order's gross", () => {
    const t = cycleTerms(armed({ capacity: 40n }), { fillableContracts: 30n })!;
    expect(t.fillableContracts).toBe(23n);
    expect(t.orderGrossIfAllFill6).toBe(23n * 414_137n);
    expect(t.orderGrossIfAllFill6).toBe(armed().listingGrossUsdg);
  });

  it("capacity unread: the caller's figure is not trusted unchecked, so no order figures", () => {
    const t = cycleTerms(armed({ capacity: undefined }), { fillableContracts: 1000n })!;
    expect(t.fillableContracts).toBeUndefined();
    expect(t.orderGrossIfAllFill6).toBeUndefined();
    expect(t.orderGrossIfAllFillFmt).toBe("—");
    expect(t.unitPriceFmt).toBe("0.414137");
  });

  it.each([2, 3])("phase %i: nothing can sell after Listed, so no order figures", (phase) => {
    const t = cycleTerms(armed({ phase }), { fillableContracts: 17n })!;
    expect(t.strikeFmt).toBe("222.00");
    expect(t.fillableContracts).toBeUndefined();
    expect(t.orderGrossIfAllFill6).toBeUndefined();
    expect(t.orderFeeIfAllFill6).toBeUndefined();
  });

  it("the fee is policy's protocolFeeBps, whatever it is, and absent until policy is read", () => {
    const at1000 = cycleTerms(armed({ policy: { ...POLICY, protocolFeeBps: 1000 } }), { fillableContracts: 17n })!;
    expect(at1000.feeBps).toBe(1000);
    expect(at1000.orderFeeIfAllFill6).toBe(704_032n); // 7,040,329 × 1000 / 10000 = 704,032.9

    const zero = cycleTerms(armed({ policy: { ...POLICY, protocolFeeBps: 0 } }), { fillableContracts: 17n })!;
    expect(zero.orderFeeIfAllFill6).toBe(0n);

    const unread = cycleTerms(armed({ policy: undefined }), { fillableContracts: 17n })!;
    expect(unread.feeBps).toBeUndefined();
    expect(unread.orderGrossIfAllFill6).toBe(7_040_329n);
    expect(unread.orderFeeIfAllFill6).toBeUndefined();
    expect(unread.orderFeeIfAllFillFmt).toBe("—");

    const nonsense = cycleTerms(armed({ policy: { ...POLICY, protocolFeeBps: 10_001 } }), { fillableContracts: 17n })!;
    expect(nonsense.feeBps).toBeUndefined();
  });

  it("protocolFeeOn floors like Policy.splitHarvest", () => {
    expect(protocolFeeOn(19_999n, 500)).toBe(999n);
    expect(protocolFeeOn(20_000n, 500)).toBe(1_000n);
    expect(protocolFeeOn(1n, 9_999)).toBe(0n);
    expect(protocolFeeOn(0n, 500)).toBe(0n);
  });

  it("the vault's listing slot sets the unit price; the caller's price is only a fallback", () => {
    expect(cycleTerms(armed(), { unitPrice6: 999_999n, fillableContracts: 1n })!.unitPrice6).toBe(414_137n);
    const empty = cycleTerms(armed({ listingAmount: 0n, listingGrossUsdg: 0n }), { unitPrice6: 500_000n, fillableContracts: 2n })!;
    expect(empty.unitPrice6).toBe(500_000n);
    expect(empty.orderGrossIfAllFill6).toBe(1_000_000n);
    const none = cycleTerms(armed({ listingAmount: 0n, listingGrossUsdg: 0n }), { fillableContracts: 2n })!;
    expect(none.unitPrice6).toBeUndefined();
    expect(none.unitPriceFmt).toBe("—");
    expect(none.orderGrossIfAllFill6).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ keeper pricing report --- */

/**
 * The sample record in keeper/README.md ("Market data (vol mode)"), verbatim: the 25 Sep arm on the
 * Cboe chain of Monday 2026-09-14 after the close.
 */
const README_RECORD = {
  mode: "vol", source: "cboe-delayed", priceSource: "vol-fair", volPath: "fresh",
  volUnavailableReason: null, targetDelta: 0.15, deltaAtStrike: 0.1464, ivAtStrike: 0.3266,
  strikeUsdg6: "225000000", strikeOtmBps: 602, deltaStrikeUsdg6: "225000000",
  strikeClamped: null, bandBufferBps: 50,
  fairUnit6: "860864", volUnit6: "946951", floorUnit6: "848840", marginUnit6: "857329",
  unitPrice6: "946951", edgeBps: 1000, marginBps: 100,
  shareSpot: 212.0404, tokenSpot: 212.21, spotUsdg6: "212210000",
  expiry: "2026-09-25", chainTimestamp: "2026-09-15 05:57:42", lastTradeTime: "2026-09-14T15:59:59",
} as const;

/** 2026-09-15T05:57:42Z and 2026-09-14T15:59:59-04:00. */
const CHAIN_TS = 1789451862;
const LAST_TRADE_TS = 1789415999;

function parsed(input: unknown): KeeperPricingFigures {
  const f = keeperPricingFigures(input);
  expect(f, JSON.stringify(input)).not.toBeNull();
  return f!;
}

describe("keeperPricingFigures: the keeper's documented record", () => {
  it("formats every figure of the README sample", () => {
    const f = parsed(README_RECORD);
    expect(f.mode).toBe("vol");
    expect(f.source).toBe("cboe-delayed");
    expect(f.priceSource).toBe("vol-fair");
    expect(f.volPath).toBe("fresh");
    expect(f.volUnavailableReason).toBeUndefined();
    expect(f.targetDelta).toBe(0.15);
    expect(f.targetDeltaFmt).toBe("0.1500");
    expect(f.deltaAtStrikeFmt).toBe("0.1464");
    expect(f.ivAtStrike).toBe(0.3266);
    expect(f.ivAtStrikeFmt).toBe("0.3266");
    expect(f.strikeUsdg6).toBe(225_000_000n);
    expect(f.strikeFmt).toBe("225.00");
    expect(f.deltaStrikeUsdg6).toBe(225_000_000n);
    expect(f.deltaStrikeFmt).toBe("225.00");
    expect(f.strikeClamped).toBeNull();
    expect(f.bandBufferBps).toBe(50);
    expect(f.spotUsdg6).toBe(212_210_000n);
    expect(f.spotFmt).toBe("212.21");
    expect(f.strikeAboveSpotUsdg6).toBe(12_790_000n);
    expect(f.strikeAboveSpotFmt).toBe("12.79");
    expect(f.fairUnitFmt).toBe("0.860864");
    expect(f.volUnitFmt).toBe("0.946951");
    expect(f.floorUnitFmt).toBe("0.848840");
    expect(f.marginUnitFmt).toBe("0.857329");
    expect(f.unitPrice6).toBe(946_951n);
    expect(f.unitPriceFmt).toBe("0.946951");
    expect(f.edgeBps).toBe(1000);
    expect(f.marginBps).toBe(100);
    expect(f.shareSpotFmt).toBe("212.0404");
    expect(f.expiryDate).toBe("2026-09-25");
    // Cboe's file timestamp is UTC, its last trade time the New York wall clock (measured,
    // keeper/README.md): both are converted, not left as two unzoned strings.
    expect(f.chainTime).toEqual({ raw: "2026-09-15 05:57:42", ts: CHAIN_TS, utc: "2026-09-15 05:57 UTC", eastern: "2026-09-15 01:57 EDT" });
    expect(f.lastTradeTime).toEqual({ raw: "2026-09-14T15:59:59", ts: LAST_TRADE_TS, utc: "2026-09-14 19:59 UTC", eastern: "2026-09-14 15:59 EDT" });
    // No figure is a percent string.
    for (const value of Object.values(f)) if (typeof value === "string") expect(value).not.toMatch(/%/);
  });

  it("the same instants sent zoned or as unix seconds parse to the same figures", () => {
    for (const [chainTimestamp, lastTradeTime] of [
      ["2026-09-15T05:57:42Z", "2026-09-14T15:59:59-04:00"],
      ["2026-09-15T05:57:42+00:00", "2026-09-14 15:59:59-0400"],
      [CHAIN_TS, LAST_TRADE_TS],
    ] as const) {
      const f = parsed({ ...README_RECORD, chainTimestamp, lastTradeTime });
      expect(f.chainTime?.ts).toBe(CHAIN_TS);
      expect(f.lastTradeTime?.ts).toBe(LAST_TRADE_TS);
      expect(f.lastTradeTime?.eastern).toBe("2026-09-14 15:59 EDT");
    }
  });

  it("a New York last trade under standard time converts with the EST offset", () => {
    const f = parsed({ ...README_RECORD, lastTradeTime: "2026-11-06T15:59:59", chainTimestamp: "2026-11-07 05:57:42" });
    expect(f.lastTradeTime?.utc).toBe("2026-11-06 20:59 UTC");
    expect(f.lastTradeTime?.eastern).toBe("2026-11-06 15:59 EST");
  });

  it("a zone-less time from another source is kept as reported, never converted on a guess", () => {
    const f = parsed({ ...README_RECORD, source: "another feed" });
    expect(f.chainTime).toEqual({ raw: "2026-09-15 05:57:42", ts: undefined, utc: "—", eastern: "—" });
    expect(f.lastTradeTime).toEqual({ raw: "2026-09-14T15:59:59", ts: undefined, utc: "—", eastern: "—" });
  });

  it("tokenSpot and strikeOtmBps are not read: spotUsdg6 is the spot, the distance is in USDG", () => {
    const f = parsed({ ...README_RECORD, tokenSpot: "garbage", strikeOtmBps: "garbage" });
    expect(f.spotUsdg6).toBe(212_210_000n);
    expect(Object.keys(f).some((k) => /otm|bps/i.test(k) && !/^(edgeBps|marginBps|bandBufferBps)$/.test(k))).toBe(false);
  });

  it("accepts an iv of zero (the keeper's usable-quote rule allows it) and both clamp edges", () => {
    expect(parsed({ ...README_RECORD, ivAtStrike: 0 }).ivAtStrikeFmt).toBe("0.0000");
    expect(parsed({ ...README_RECORD, strikeClamped: "band-floor" }).strikeClamped).toBe("band-floor");
    expect(parsed({ ...README_RECORD, strikeClamped: "band-ceiling" }).strikeClamped).toBe("band-ceiling");
  });

  it("deltas and iv are truncated, never rounded to a value they are not", () => {
    expect(parsed({ ...README_RECORD, targetDelta: 0.98999 }).targetDeltaFmt).toBe("0.9899");
    expect(parsed({ ...README_RECORD, targetDelta: 0.29 }).targetDeltaFmt).toBe("0.2900");
    expect(parsed({ ...README_RECORD, deltaAtStrike: 0.99996 }).deltaAtStrikeFmt).toBe("0.9999");
    expect(parsed({ ...README_RECORD, deltaAtStrike: 0.00001 }).deltaAtStrikeFmt).toBe("0.0000");
    expect(parsed({ ...README_RECORD, deltaAtStrike: 1e-7 }).deltaAtStrikeFmt).toBe("0.0000");
    expect(parsed({ ...README_RECORD, ivAtStrike: 0.32669 }).ivAtStrikeFmt).toBe("0.3266");
    expect(parsed({ ...README_RECORD, shareSpot: 212.1 }).shareSpotFmt).toBe("212.10");
    expect(parsed({ ...README_RECORD, shareSpot: 212.04049 }).shareSpotFmt).toBe("212.0404");
  });

  it("never throws: throwing getters and proxies are null, inherited fields are not read", () => {
    const getter = { ...README_RECORD };
    Object.defineProperty(getter, "unitPrice6", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    expect(keeperPricingFigures(getter)).toBeNull();
    const proxy = new Proxy(
      { ...README_RECORD },
      {
        get() {
          throw new Error("boom");
        },
        has() {
          throw new Error("boom");
        },
        getOwnPropertyDescriptor() {
          throw new Error("boom");
        },
      },
    );
    expect(keeperPricingFigures(proxy)).toBeNull();
    const revocable = Proxy.revocable({ ...README_RECORD }, {});
    revocable.revoke();
    expect(keeperPricingFigures(revocable.proxy)).toBeNull();
    expect(keeperPricingFigures(Object.create(README_RECORD))).toBeNull();
    expect(keeperPricingFigures(JSON.parse(`{"__proto__": ${JSON.stringify(README_RECORD)}}`))).toBeNull();
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["an array", [README_RECORD]],
    ["a string", "vol"],
    ["mode missing", { ...README_RECORD, mode: undefined }],
    ["mode unknown", { ...README_RECORD, mode: "market" }],
    ["vol mode without a source", { ...README_RECORD, source: null }],
    ["source with markup", { ...README_RECORD, source: "<b>cboe</b>" }],
    ["priceSource unknown", { ...README_RECORD, priceSource: "market" }],
    ["volPath unknown", { ...README_RECORD, volPath: "stale" }],
    ["volUnavailableReason with markup", { ...README_RECORD, volUnavailableReason: "<i>x</i>" }],
    ["strikeClamped as a boolean", { ...README_RECORD, strikeClamped: false }],
    ["strikeClamped unknown", { ...README_RECORD, strikeClamped: "band-middle" }],
    ["vol mode without a target delta", { ...README_RECORD, targetDelta: null }],
    ["targetDelta 0", { ...README_RECORD, targetDelta: 0 }],
    ["targetDelta 0.00001 (would print as 0)", { ...README_RECORD, targetDelta: 0.00001 }],
    ["targetDelta 0.99999 (would print as 1)", { ...README_RECORD, targetDelta: 0.99999 }],
    ["targetDelta as a string", { ...README_RECORD, targetDelta: "0.15" }],
    ["targetDelta NaN", { ...README_RECORD, targetDelta: Number.NaN }],
    ["deltaAtStrike above 1", { ...README_RECORD, deltaAtStrike: 1.2 }],
    ["ivAtStrike sent as a percent", { ...README_RECORD, ivAtStrike: 32.66 }],
    ["ivAtStrike negative", { ...README_RECORD, ivAtStrike: -0.1 }],
    ["shareSpot sent in base units", { ...README_RECORD, shareSpot: 212_040_400 }],
    ["strikeUsdg6 missing", { ...README_RECORD, strikeUsdg6: undefined }],
    ["strikeUsdg6 as a number", { ...README_RECORD, strikeUsdg6: 225000000 }],
    ["strikeUsdg6 as dollars", { ...README_RECORD, strikeUsdg6: "225.00" }],
    ["spotUsdg6 missing", { ...README_RECORD, spotUsdg6: undefined }],
    ["spotUsdg6 sent in dollars", { ...README_RECORD, spotUsdg6: "212" }],
    ["floorUnit6 zero", { ...README_RECORD, floorUnit6: "0", marginUnit6: "0" }],
    ["floorUnit6 negative", { ...README_RECORD, floorUnit6: "-5" }],
    ["unitPrice6 above the strike", { ...README_RECORD, strikeUsdg6: "900000" }],
    ["unitPrice6 below the floor", { ...README_RECORD, priceSource: "manual-override", unitPrice6: "848839" }],
    ["marginUnit6 not the floor with the margin", { ...README_RECORD, marginUnit6: "857330" }],
    ["marginBps not the one marginUnit6 was built with", { ...README_RECORD, marginBps: 50 }],
    ["volUnit6 not the fair value with the edge", { ...README_RECORD, volUnit6: "946950", unitPrice6: "946950" }],
    ["edgeBps not the one volUnit6 was built with", { ...README_RECORD, edgeBps: 900 }],
    ["edgeBps fractional", { ...README_RECORD, edgeBps: 1000.5 }],
    ["edgeBps as a string", { ...README_RECORD, edgeBps: "1000" }],
    ["vol mode without an edge", { ...README_RECORD, edgeBps: null }],
    ["volUnit6 without a fair value", { ...README_RECORD, fairUnit6: null }],
    ["fill-floor with an ask that is not the floor with the margin", { ...README_RECORD, priceSource: "fill-floor" }],
    ["vol-fair on a previous-fair path", { ...README_RECORD, volPath: "previous-fair" }],
    ["vol-previous-fair on a fresh path", { ...README_RECORD, priceSource: "vol-previous-fair" }],
    ["vol-fair with an ask that is not the market ask", { ...README_RECORD, unitPrice6: "946952" }],
    ["fresh without a chain timestamp", { ...README_RECORD, chainTimestamp: null }],
    ["fresh without an expiry", { ...README_RECORD, expiry: null }],
    ["expiry not a real date", { ...README_RECORD, expiry: "2026-02-30" }],
    ["expiry in the option symbol's form", { ...README_RECORD, expiry: "260925" }],
    ["chainTimestamp in milliseconds", { ...README_RECORD, chainTimestamp: CHAIN_TS * 1000 }],
    ["chainTimestamp in year 5138", { ...README_RECORD, chainTimestamp: 99_999_999_999 }],
    ["chainTimestamp before 2020", { ...README_RECORD, chainTimestamp: "1969-12-31T00:00:00Z" }],
    ["chainTimestamp in year 9999", { ...README_RECORD, chainTimestamp: "9999-12-31T23:59:59Z" }],
    ["chainTimestamp hour 24", { ...README_RECORD, chainTimestamp: "2026-09-15T24:00:00Z" }],
    ["chainTimestamp hour 25", { ...README_RECORD, chainTimestamp: "2026-09-15 25:00:00" }],
    ["chainTimestamp offset +23:59", { ...README_RECORD, chainTimestamp: "2026-09-15T05:57:42+23:59" }],
    ["chainTimestamp not a time", { ...README_RECORD, chainTimestamp: "yesterday" }],
    ["lastTradeTime a boolean", { ...README_RECORD, lastTradeTime: true }],
    ["lastTradeTime in New York's spring-forward gap", { ...README_RECORD, lastTradeTime: "2026-03-08T02:30:00" }],
    ["fixed mode with a vol path", { ...README_RECORD, mode: "fixed", source: null }],
  ])("malformed or inconsistent: %s → null", (_label, input) => {
    expect(keeperPricingFigures(input)).toBeNull();
  });
});

/* ------------------------------------------- the same helper on the keeper's own output --- */

type KeeperRecord = Record<string, unknown>;
type KeeperResult = { ok: true; pricing: KeeperRecord; unitPrice6: bigint; strikeUsdg6?: bigint } | { ok: false; reason: string };
type KeeperPolicy = {
  planWeek: (input: Record<string, unknown>) => KeeperResult;
  priceListing: (input: Record<string, unknown>) => KeeperResult;
};
type KeeperVol = { parseCboeChain: (raw: unknown) => unknown };

/**
 * Feeds records made by the keeper's real planWeek / priceListing (keeper/src/policy.ts) on its
 * Cboe fixture straight into keeperPricingFigures, after the JSON round trip /orders and /state put
 * them through. A shape change on either side fails here. The keeper validates process.env when
 * config.ts is imported, so the environment is set first, as keeper/src/policy.vol.test.ts does;
 * the import path is built at runtime so web's type check stays within web/.
 */
describe("keeperPricingFigures on records the keeper produces", () => {
  const keeperSrc = fileURLToPath(new URL("../../keeper/src/", import.meta.url));
  const LAUNCH = { minOtmBps: 300n, maxOtmBps: 1200n, minPremiumBps: 40n, maxUtilizationBps: 9500n, protocolFeeBps: 500n, maxContractsCap: 50n };
  const LOT = 10n ** 18n;
  const SPOT = 212_210_000n;
  const NOW = Date.UTC(2026, 8, 15, 8, 30, 0) / 1000;
  const KNOBS = {
    pricingMode: "vol",
    targetDelta: 0.15,
    priceEdgeBps: 1000,
    premiumMarginBps: 100,
    volMaxAgeS: 345_600,
    volMaxSpotDivergenceBps: 300,
    strikeBandBufferBps: 50,
    unitPriceOverride6: null,
  };
  let policy: KeeperPolicy;
  let chain: unknown;

  beforeAll(async () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      KEEPER_ENV_FILE: "/dev/null",
      RH_RPC: "http://127.0.0.1:9",
      VAULT: "0x1111111111111111111111111111111111111111",
      KEEPER_PK: `0x${"11".repeat(32)}`,
      KEEPER_DB_PATH: join(mkdtempSync(join(tmpdir(), "callhouse-web-pricing-")), "keeper.db"),
      KEEPER_LOG_LEVEL: "fatal",
    });
    for (const key of Object.keys(process.env)) {
      if (/^KEEPER_(PRICING_MODE|TARGET_DELTA|PRICE_EDGE_BPS|VOL_|STRIKE_|UNIT_PRICE|PREMIUM_MARGIN)/.test(key)) delete process.env[key];
    }
    try {
      policy = (await import(/* @vite-ignore */ join(keeperSrc, "policy.ts"))) as KeeperPolicy;
      const vol = (await import(/* @vite-ignore */ join(keeperSrc, "vol.ts"))) as KeeperVol;
      chain = vol.parseCboeChain(JSON.parse(readFileSync(join(keeperSrc, "fixtures", "cboe-nvda-2026-09-14.json"), "utf8")));
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  function volCtx(closeDay: string, overrides: Record<string, unknown> = {}) {
    return { chain, error: null, closeDay, nowSeconds: NOW, ...overrides };
  }

  function plan(overrides: Record<string, unknown> = {}): KeeperRecord {
    const r = policy.planWeek({
      policy: LAUNCH,
      spotUsdg6: SPOT,
      totalAssets: 25n * LOT,
      contractsWritten: 0n,
      feesEnabled: false,
      feeBps: 15,
      vol: volCtx("2026-09-25"),
      ...KNOBS,
      ...overrides,
    });
    expect(r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
    return (r as { pricing: KeeperRecord }).pricing;
  }

  function price(overrides: Record<string, unknown>): KeeperRecord {
    const r = policy.priceListing({
      policy: LAUNCH,
      spotUsdg6: SPOT,
      strikeUsdg6: 225_000_000n,
      contracts: 23n,
      feesEnabled: false,
      feeBps: 15,
      ...KNOBS,
      ...overrides,
    });
    expect(r.ok, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(true);
    return (r as { pricing: KeeperRecord }).pricing;
  }

  /** What /orders and /state serve: the stored JSON, parsed back. */
  function served(record: KeeperRecord): unknown {
    return JSON.parse(JSON.stringify(record));
  }

  /** Every figure the page shows equals the keeper's own number. */
  function expectMirrors(f: KeeperPricingFigures, r: KeeperRecord): void {
    const big = (x: unknown) => (x === null ? undefined : BigInt(x as string));
    const opt = (x: unknown) => (x === null ? undefined : x);
    expect(f.mode).toBe(r.mode);
    expect(f.source).toBe(opt(r.source));
    expect(f.priceSource).toBe(r.priceSource);
    expect(f.volPath).toBe(opt(r.volPath));
    expect(f.volUnavailableReason).toBe(opt(r.volUnavailableReason));
    expect(f.targetDelta).toBe(opt(r.targetDelta));
    expect(f.deltaAtStrike).toBe(opt(r.deltaAtStrike));
    expect(f.ivAtStrike).toBe(opt(r.ivAtStrike));
    expect(f.strikeUsdg6).toBe(big(r.strikeUsdg6));
    expect(f.deltaStrikeUsdg6).toBe(big(r.deltaStrikeUsdg6));
    expect(f.strikeClamped).toBe(r.strikeClamped);
    expect(f.bandBufferBps).toBe(opt(r.bandBufferBps));
    expect(f.spotUsdg6).toBe(big(r.spotUsdg6));
    expect(f.fairUnit6).toBe(big(r.fairUnit6));
    expect(f.volUnit6).toBe(big(r.volUnit6));
    expect(f.floorUnit6).toBe(big(r.floorUnit6));
    expect(f.marginUnit6).toBe(big(r.marginUnit6));
    expect(f.unitPrice6).toBe(big(r.unitPrice6));
    expect(f.edgeBps).toBe(opt(r.edgeBps));
    expect(f.marginBps).toBe(r.marginBps);
    expect(f.shareSpot).toBe(opt(r.shareSpot));
    expect(f.expiryDate).toBe(opt(r.expiry));
    expect(f.chainTime?.raw).toBe(opt(r.chainTimestamp));
    expect(f.lastTradeTime?.raw).toBe(opt(r.lastTradeTime));
  }

  it("vol arm, 25 Sep: the market ask; both Cboe clocks convert", () => {
    const r = plan();
    const f = parsed(served(r));
    expectMirrors(f, r);
    expect(f.priceSource).toBe("vol-fair");
    expect(f.unitPriceFmt).toBe("0.946951");
    expect(f.chainTime?.ts).toBe(CHAIN_TS);
    expect(f.lastTradeTime?.ts).toBe(LAST_TRADE_TS);
  });

  it("vol arm, 18 Sep: the vault floor with the margin binds, and the market ask it beat is shown", () => {
    const r = plan({ vol: volCtx("2026-09-18") });
    const f = parsed(served(r));
    expectMirrors(f, r);
    expect(f.priceSource).toBe("fill-floor");
    expect(f.volUnitFmt).toBe("0.720957");
    expect(f.marginUnitFmt).toBe("0.857329");
    expect(f.unitPriceFmt).toBe("0.857329");
  });

  it("vol arm with the delta strike below the band: the clamp edge and the pre-clamp strike", () => {
    const r = plan({ targetDelta: 0.35 });
    const f = parsed(served(r));
    expectMirrors(f, r);
    expect(f.strikeClamped).toBe("band-floor");
    expect(f.deltaStrikeUsdg6).not.toBe(f.strikeUsdg6);
  });

  it("fixed mode: no source, delta or edge, and the strike and ask still show", () => {
    const r = plan({ pricingMode: "fixed", strikeOtmBps: 500, vol: null });
    const f = parsed(served(r));
    expectMirrors(f, r);
    expect(f.mode).toBe("fixed");
    expect(f.source).toBeUndefined();
    expect(f.targetDeltaFmt).toBe("—");
    expect(f.strikeFmt).not.toBe("—");
    expect(f.unitPriceFmt).not.toBe("—");
  });

  it("a reprice on a stale chain: the previous listing's fair value, undated", () => {
    const r = price({ vol: volCtx("2026-09-25", { nowSeconds: NOW + 30 * 86_400 }), previousFairUnit6: 900_000n });
    expect(r.volPath).toBe("previous-fair");
    const f = parsed(served(r));
    expectMirrors(f, r);
    expect(f.priceSource).toBe("vol-previous-fair");
    expect(f.volUnavailableReason).toBe("vol-stale");
    expect(f.chainTime).toBeUndefined();
  });

  it("a reprice with a previous fair value below the floor: the floor binds", () => {
    const r = price({ vol: { chain: null, error: "timeout", closeDay: "2026-09-25", nowSeconds: NOW }, previousFairUnit6: 100_000n });
    const f = parsed(served(r));
    expectMirrors(f, r);
    expect(f.priceSource).toBe("fill-floor");
    expect(f.volPath).toBe("previous-fair");
  });

  it("a manual override, with fresh data and on a previous fair value", () => {
    // In vol mode the keeper never lists without a market-based fair value, override or not, and the
    // override can only raise the ask (1.234567 is above both 0.946951 asks here).
    for (const vol of [volCtx("2026-09-25"), { chain: null, error: "timeout", closeDay: "2026-09-25", nowSeconds: NOW }]) {
      const r = price({ vol, unitPriceOverride6: 1_234_567n, previousFairUnit6: 860_864n });
      const f = parsed(served(r));
      expectMirrors(f, r);
      expect(f.priceSource).toBe("manual-override");
      expect(f.unitPriceFmt).toBe("1.234567");
    }
  });
});

/* ---------------------------------------------------------------------------------- copy --- */

/**
 * copy-lint's FORBIDDEN table, read out of scripts/copy-lint.mjs rather than copied, so a rule
 * added there is applied here too. The script runs its self-test and exits when imported, so it
 * is parsed as text.
 */
function forbiddenFromCopyLint(): RegExp[] {
  const source = readFileSync(fileURLToPath(new URL("../../scripts/copy-lint.mjs", import.meta.url)), "utf8");
  const start = source.indexOf("const FORBIDDEN = [");
  const end = source.indexOf("];", start);
  expect(start).toBeGreaterThan(-1);
  const table = source.slice(start, end);
  return [...table.matchAll(/re:\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)/g)].map((m) => new RegExp(m[1]!, m[2]));
}

describe("CYCLE_TERMS_LABELS", () => {
  const labels = Object.values(CYCLE_TERMS_LABELS);

  it("pass every copy-lint FORBIDDEN rule", () => {
    const rules = forbiddenFromCopyLint();
    expect(rules.length).toBeGreaterThanOrEqual(9);
    // The extraction is live: a known-bad phrase trips at least one rule. Assembled at runtime,
    // because this file is itself scanned by copy-lint.
    const knownBad = ["projected", "yield"].join(" ");
    expect(rules.some((re) => re.test(knownBad))).toBe(true);
    for (const label of labels) {
      for (const re of rules) expect(re.test(label), `${JSON.stringify(label)} vs ${re}`).toBe(false);
    }
  });

  it("carry no return, profit, per-year or percentage framing", () => {
    const framing = [/\byield/i, /\breturns?\b/i, /\bprofit/i, /\bearn/i, /\bgain/i, /\bincome/i, /\bannual/i, /per\s+year/i, /%/, /\bprojected/i, /\bguarantee/i, /\bexpected/i, /\bestimat/i];
    for (const label of labels) {
      for (const re of framing) expect(re.test(label), `${JSON.stringify(label)} vs ${re}`).toBe(false);
    }
  });
});
