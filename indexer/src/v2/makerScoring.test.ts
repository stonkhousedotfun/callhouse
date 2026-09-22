import { describe, expect, it } from "vitest";

import type { FillableOrder } from "../../lib/v2/book";
import {
  advanceMakerEpoch, emptyMakerEpoch, enrolledMakerKeys, DEPTH_BAND_BPS, MAKER_BENCHMARK_POLICY,
  MAKER_SCORING_POLICY, makerWeekIndex, makerWeekStartFromIndex, makerWeekStartUtc, sampleMakerSeries,
  scoreMakerEpochs, withinBand, type MakerQuality, type MakerSample, type ScoringBand,
} from "../../lib/v2/makerScoring";

const A = "0x0000000000000000000000000000000000000001" as const;
const B = "0x0000000000000000000000000000000000000002" as const;

function order(kind: FillableOrder["kind"], price: bigint, units = 100n): FillableOrder {
  return { orderId: 1n, maker: A, kind, price, units, validUntil: 1000n, placedAt: 0n, placedBlock: 1n };
}

const valid = (quality: MakerQuality): MakerSample => ({ kind: "valid", quality });
const ABSENT: MakerSample = { kind: "absent" };
const MISSING_REFERENCE: MakerSample = { kind: "missingReference" };

describe("maker epoch calendar", () => {
  it("uses Monday UTC and the RewardsDistributor index across New York DST", () => {
    const seconds = (date: string) => BigInt(Date.parse(date) / 1000);
    const september = seconds("2026-09-16T12:00:00Z");
    const monday = seconds("2026-09-14T00:00:00Z");
    expect(makerWeekStartUtc(september)).toBe(monday);
    expect(makerWeekIndex(monday)).toBe(2958n);
    expect(makerWeekStartFromIndex(2958n)).toBe(monday);
    expect(makerWeekStartUtc(seconds("2026-03-08T23:59:59Z"))).toBe(seconds("2026-03-02T00:00:00Z"));
    expect(makerWeekStartUtc(seconds("2026-03-09T00:00:00Z"))).toBe(seconds("2026-03-09T00:00:00Z"));
    expect(makerWeekStartUtc(seconds("2026-11-02T00:00:00Z"))).toBe(seconds("2026-11-02T00:00:00Z"));
  });
});

describe("maker observations and score", () => {
  // A 2 USDG fair, where 1000 bps (0.2 USDG) is far above the 0.02 USDG floor: the band is proportional.
  const FAIR = 2_000_000n;

  it("takes the two-sided test and depthInBand from the epoch band, and depthWithin100bps from 100 bps", () => {
    // 1990000 and 2010000 are 50 bps out: inside both bands. 1850000 is 750 bps out: inside the epoch
    // band only, and BELOW the best bid so the book does not cross. 2300000 is 1500 bps out: outside both.
    const quality = sampleMakerSeries([
      order("Bid", 1_990_000n, 10n), order("AskResale", 2_010_000n, 20n),
      order("Bid", 1_850_000n, 30n), order("AskResale", 2_300_000n, 40n),
    ], FAIR);
    expect(quality).toEqual({ twoSided: true, spreadBps: 100n, depthWithin100bps: 30n, depthInBand: 60n });

    // The 100 bps figure does not move when the band widens; that is the whole point of keeping both.
    const wider: ScoringBand = { bps: 5_000n, minUsdg: 0n };
    const widened = sampleMakerSeries([
      order("Bid", 1_990_000n, 10n), order("AskResale", 2_010_000n, 20n),
      order("Bid", 1_850_000n, 30n), order("AskResale", 2_300_000n, 40n),
    ], FAIR, wider);
    expect(widened.depthWithin100bps).toBe(30n);
    expect(widened.depthInBand).toBe(100n);
  });

  it("uses the absolute floor when a cheap series makes the proportional band narrower than a tick", () => {
    // Fair 0.01 USDG: 1000 bps is 0.001 USDG, narrower than one PRICE_TICK, so the 0.02 USDG floor rules.
    const cheap = sampleMakerSeries([order("Bid", 9_950n, 10n), order("AskResale", 25_000n, 20n)], 10_000n);
    expect(cheap).toEqual({ twoSided: true, spreadBps: 15_050n, depthWithin100bps: 10n, depthInBand: 30n });
    expect(withinBand(25_000n, 10_000n, MAKER_SCORING_POLICY.band)).toBe(true);
    // Without the floor the same quote is outside, and the maker reads as one-sided.
    expect(withinBand(25_000n, 10_000n, { bps: 1_000n, minUsdg: 0n })).toBe(false);
  });

  it("refuses a band it cannot measure against rather than scoring one", () => {
    expect(() => sampleMakerSeries([], 0n)).toThrow(/invalid fair quote/);
    expect(() => sampleMakerSeries([], FAIR, { bps: 10_001n, minUsdg: 0n })).toThrow(/invalid scoring band/);
    expect(() => sampleMakerSeries([], FAIR, { bps: 100n, minUsdg: -1n })).toThrow(/invalid scoring band/);
  });

  it("rolls samples and replaces event-derived fill totals without recounting", () => {
    const one = advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [
      valid({ twoSided: true, spreadBps: 100n, depthWithin100bps: 200n, depthInBand: 260n }),
      valid({ twoSided: false, spreadBps: null, depthWithin100bps: 0n, depthInBand: 0n }),
    ], { fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n }, 10);
    const two = advanceMakerEpoch(one, [valid({ twoSided: true, spreadBps: 50n, depthWithin100bps: 100n, depthInBand: 160n })],
      { fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n }, 10);
    expect(two).toMatchObject({ samples: 3, validSamples: 3, absentSamples: 0, twoSidedSamples: 2, uptimePpm: 666_666n,
      avgSpreadBps: 75n, depthWithin100bps: 100n, depthInBand: 140n, fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n });
  });

  it("continues updating a previously enrolled maker after every resting order is gone", () => {
    const enrolled = enrolledMakerKeys(new Map([[A, 0]]), new Map(), [A]);
    expect([...enrolled]).toEqual([A]);
    const previous = { ...emptyMakerEpoch(A, 2958n), samples: 1, validSamples: 1, twoSidedSamples: 1,
      uptimePpm: 1_000_000n, fills: 1, volumeUsdg: 100n, rebatesUsdg: 2n };
    const next = advanceMakerEpoch(previous, [ABSENT], { fills: 2, volumeUsdg: 300n, rebatesUsdg: 5n }, 0);
    expect(next).toMatchObject({ samples: 2, absentSamples: 1, validSamples: 1, twoSidedSamples: 1,
      uptimePpm: 500_000n, fills: 2, volumeUsdg: 300n, rebatesUsdg: 5n });
  });

  // T-312 PROVE BY BREAKING (authored, not run under build mode). Both makers end the epoch at the same
  // samples, uptime, depth and score; ONLY the kind counts tell a maker that never quoted from one that
  // quoted and measured zero. Count an absent sample as valid (or the reverse) in advanceMakerEpoch and
  // this goes red on absentSamples / validSamples.
  it("keeps a maker with no quotes apart from a maker whose quotes measured zero", () => {
    const flows = { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    // Both legs sit outside even the floor-widened band, so this is a measured sample of zero, not downtime.
    const measuredZero = valid(sampleMakerSeries([order("Bid", 1_000_000n), order("AskResale", 4_000_000n)], 2_000_000n));
    expect(measuredZero).toEqual(valid({ twoSided: false, spreadBps: null, depthWithin100bps: 0n, depthInBand: 0n }));
    const neverQuoted = advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [ABSENT, ABSENT, ABSENT], flows, 0);
    const quotedZero = advanceMakerEpoch(emptyMakerEpoch(B, 2958n), [measuredZero, measuredZero, measuredZero], flows, 0);
    const [scoredAbsent, scoredZero] = scoreMakerEpochs([neverQuoted, quotedZero]);

    const shared = { samples: 3, twoSidedSamples: 0, uptimePpm: 0n, depthWithin100bps: 0n, depthInBand: 0n, scorePpm: 0n };
    expect(scoredAbsent).toMatchObject(shared);
    expect(scoredZero).toMatchObject(shared);
    expect(scoredAbsent).toMatchObject({ absentSamples: 3, validSamples: 0, missingReferenceSamples: 0 });
    expect(scoredZero).toMatchObject({ absentSamples: 0, validSamples: 3, missingReferenceSamples: 0 });
  });

  it("counts a missing reference without letting it move uptime, depth or samples", () => {
    const flows = { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    const measured = advanceMakerEpoch(emptyMakerEpoch(A, 2958n),
      [valid({ twoSided: true, spreadBps: 40n, depthWithin100bps: 300n, depthInBand: 300n })], flows, 0);
    const next = advanceMakerEpoch(measured, [MISSING_REFERENCE, MISSING_REFERENCE], flows, 0);
    expect(next).toMatchObject({ samples: 1, validSamples: 1, absentSamples: 0, missingReferenceSamples: 2,
      twoSidedSamples: 1, uptimePpm: 1_000_000n, avgSpreadBps: 40n, depthWithin100bps: 300n, depthInBand: 300n });
  });

  it("labels every row with the benchmark policy and refuses to extend a row from another policy", () => {
    expect(MAKER_BENCHMARK_POLICY).toBe(2);
    const flows = { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    expect(emptyMakerEpoch(A, 2958n).benchmarkPolicy).toBe(MAKER_BENCHMARK_POLICY);
    expect(advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [ABSENT], flows, 0).benchmarkPolicy).toBe(MAKER_BENCHMARK_POLICY);
    const policyOne = { ...emptyMakerEpoch(A, 2958n), benchmarkPolicy: 1 };
    expect(() => advanceMakerEpoch(policyOne, [ABSENT], flows, 0)).toThrow(/benchmark policy 1, not 2/);
  });

  it("weights uptime, depth, spread and volume from the published policy, never from this file", () => {
    const w = MAKER_SCORING_POLICY.weights;
    const top = { ...emptyMakerEpoch(A, 2958n), samples: 1, twoSidedSamples: 1, uptimePpm: 1_000_000n,
      depthWithin100bps: 200n, depthInBand: 200n, avgSpreadBps: 50n, volumeUsdg: 200n };
    const low = { ...emptyMakerEpoch(B, 2958n), samples: 1, twoSidedSamples: 1, uptimePpm: 500_000n,
      depthWithin100bps: 100n, depthInBand: 100n, avgSpreadBps: 100n, volumeUsdg: 100n };
    const scores = scoreMakerEpochs([top, low]);
    // Derived from the policy rather than restated: the leader takes every rank, the laggard takes none
    // but keeps half its uptime weight.
    expect(scores[0]?.scorePpm).toBe((w.uptime * 1_000_000n + w.depth * 1_000_000n + w.spread * 1_000_000n + w.volume * 1_000_000n) / 100n);
    expect(scores[1]?.scorePpm).toBe((w.uptime * 500_000n) / 100n);
  });

  /**
   * THE SCORE RANKS ON THE BAND STATISTIC. Two makers identical except for which depth column carries
   * their units: the one with band depth outranks the one whose units sit only in the 100 bps column.
   * Rank depthWithin100bps here instead (wrong fix a, in its scoring half) and this goes red.
   */
  it("ranks depth on depthInBand, the policy statistic, not on the fixed 100 bps column", () => {
    const bandDeep = { ...emptyMakerEpoch(A, 2958n), samples: 1, depthWithin100bps: 0n, depthInBand: 500n };
    const fixedDeep = { ...emptyMakerEpoch(B, 2958n), samples: 1, depthWithin100bps: 500n, depthInBand: 0n };
    const [scoredBand, scoredFixed] = scoreMakerEpochs([bandDeep, fixedDeep]);
    expect(scoredBand?.scorePpm).toBe((MAKER_SCORING_POLICY.weights.depth * 1_000_000n) / 100n);
    expect(scoredFixed?.scorePpm).toBe(0n);
  });

  /**
   * WRONG FIX (a), the sampling half: depthWithin100bps must keep its 100 bps meaning whatever the epoch
   * band is. Point it at the band and this goes red naming the field.
   */
  it("keeps depthWithin100bps on 100 bps while the band moves under it", () => {
    expect(DEPTH_BAND_BPS).toBe(100n);
    const orders = [order("Bid", 1_990_000n, 10n), order("AskResale", 2_150_000n, 30n)];
    const narrow = sampleMakerSeries(orders, FAIR, { bps: 100n, minUsdg: 0n });
    const wide = sampleMakerSeries(orders, FAIR, { bps: 2_000n, minUsdg: 0n });
    expect(narrow.depthWithin100bps).toBe(10n);
    expect(wide.depthWithin100bps).toBe(10n);
    expect(narrow.depthInBand).toBe(10n);
    expect(wide.depthInBand).toBe(40n);
    // And the policy default is not 100 bps, so a producer that quietly used DEPTH_BAND_BPS for the band
    // would be publishing a different measurement under the name `depthInBand`.
    expect(MAKER_SCORING_POLICY.band.bps).not.toBe(DEPTH_BAND_BPS);
  });

  /**
   * WRONG FIX (b): a sample with no chain reference must never be scored as fair = 0 or as downtime.
   * `sampleMakerSeries` refuses a zero fair outright, and the epoch keeps the three kinds apart.
   */
  it("cannot score a missing reference as a zero fair or as downtime", () => {
    expect(() => sampleMakerSeries([order("Bid", 1_990_000n)], 0n)).toThrow(/invalid fair quote/);
    const flows = { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    const missing = advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [MISSING_REFERENCE, MISSING_REFERENCE], flows, 0);
    const downtime = advanceMakerEpoch(emptyMakerEpoch(B, 2958n), [ABSENT, ABSENT], flows, 0);
    expect(missing).toMatchObject({ samples: 0, absentSamples: 0, missingReferenceSamples: 2, uptimePpm: 0n });
    expect(downtime).toMatchObject({ samples: 2, absentSamples: 2, missingReferenceSamples: 0, uptimePpm: 0n });
    // The distinction survives scoring: only the maker that was actually absent has scored samples.
    const [scoredMissing, scoredDowntime] = scoreMakerEpochs([missing, downtime]);
    expect(scoredMissing?.samples).toBe(0);
    expect(scoredDowntime?.samples).toBe(2);
  });

  it("publishes a policy whose weights sum to 100 and whose band is data, not a literal", () => {
    const w = MAKER_SCORING_POLICY.weights;
    expect(w.uptime + w.depth + w.spread + w.volume).toBe(100n);
    expect(MAKER_SCORING_POLICY.band).toEqual({ bps: 1_000n, minUsdg: 20_000n });
    expect(MAKER_SCORING_POLICY.version).toBe(1);
  });
});
