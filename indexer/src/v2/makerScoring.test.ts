import { describe, expect, it } from "vitest";

import type { FillableOrder } from "../../lib/v2/book";
import {
  advanceMakerEpoch, emptyMakerEpoch, enrolledMakerKeys, makerWeekIndex, makerWeekStartFromIndex,
  makerWeekStartUtc, sampleMakerSeries, scoreMakerEpochs,
} from "../../lib/v2/makerScoring";

const A = "0x0000000000000000000000000000000000000001" as const;
const B = "0x0000000000000000000000000000000000000002" as const;

function order(kind: FillableOrder["kind"], price: bigint, units = 100n): FillableOrder {
  return { orderId: 1n, maker: A, kind, price, units, validUntil: 1000n, placedAt: 0n, placedBlock: 1n };
}

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
  it("requires both sides within one percent of fair and counts depth within the same band", () => {
    expect(sampleMakerSeries([order("Bid", 9_950n, 10n), order("AskResale", 10_050n, 20n),
      order("Bid", 9_800n, 30n)], 10_000n)).toEqual({ twoSided: true, spreadBps: 100n, depthWithin100bps: 30n });
    expect(sampleMakerSeries([order("Bid", 9_950n), order("AskResale", 10_200n)], 10_000n)).toEqual({
      twoSided: false, spreadBps: null, depthWithin100bps: 100n,
    });
  });

  it("rolls samples and replaces event-derived fill totals without recounting", () => {
    const one = advanceMakerEpoch(emptyMakerEpoch(A, 2958n), [
      { twoSided: true, spreadBps: 100n, depthWithin100bps: 200n },
      { twoSided: false, spreadBps: null, depthWithin100bps: 0n },
    ], { fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n }, 10);
    const two = advanceMakerEpoch(one, [{ twoSided: true, spreadBps: 50n, depthWithin100bps: 100n }],
      { fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n }, 10);
    expect(two).toMatchObject({ samples: 3, twoSidedSamples: 2, uptimePpm: 666_666n,
      avgSpreadBps: 75n, depthWithin100bps: 100n, fills: 2, volumeUsdg: 1_000_000n, rebatesUsdg: 2_000n });
  });

  it("continues updating a previously enrolled maker after every resting order is gone", () => {
    const enrolled = enrolledMakerKeys(new Map([[A, 0]]), new Map(), [A]);
    expect([...enrolled]).toEqual([A]);
    const previous = { ...emptyMakerEpoch(A, 2958n), samples: 1, twoSidedSamples: 1, uptimePpm: 1_000_000n,
      fills: 1, volumeUsdg: 100n, rebatesUsdg: 2n };
    const next = advanceMakerEpoch(previous, [sampleMakerSeries([], 10_000n)],
      { fills: 2, volumeUsdg: 300n, rebatesUsdg: 5n }, 0);
    expect(next).toMatchObject({ samples: 2, twoSidedSamples: 1, uptimePpm: 500_000n,
      fills: 2, volumeUsdg: 300n, rebatesUsdg: 5n });
  });

  it("weights uptime, depth, spread, and volume ranks in ppm", () => {
    const top = { ...emptyMakerEpoch(A, 2958n), samples: 1, twoSidedSamples: 1, uptimePpm: 1_000_000n,
      depthWithin100bps: 200n, avgSpreadBps: 50n, volumeUsdg: 200n };
    const low = { ...emptyMakerEpoch(B, 2958n), samples: 1, twoSidedSamples: 1, uptimePpm: 500_000n,
      depthWithin100bps: 100n, avgSpreadBps: 100n, volumeUsdg: 100n };
    const scores = scoreMakerEpochs([top, low]);
    expect(scores[0]?.scorePpm).toBe(1_000_000n);
    expect(scores[1]?.scorePpm).toBe(200_000n);
  });
});
