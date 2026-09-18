import { describe, expect, it } from "vitest";
import { makerEpochUtc, nyDayBounds, rankTotals, windowStarts } from "../../lib/v2/windows";

const utc = (value: string) => BigInt(Date.parse(value) / 1000);

describe("v2 leaderboard and maker epochs", () => {
  it("starts New York windows at Monday local midnight across DST", () => {
    expect(windowStarts(utc("2026-03-09T03:59:00Z")).week).toBe(utc("2026-03-02T05:00:00Z"));
    expect(windowStarts(utc("2026-03-09T04:01:00Z")).month).toBe(utc("2026-03-01T05:00:00Z"));
    expect(windowStarts(utc("2026-03-09T04:01:00Z")).all).toBe(0n);
    expect(windowStarts(utc("2026-03-09T04:01:00Z")).week).toBe(utc("2026-03-09T04:00:00Z"));
    expect(makerEpochUtc(utc("2026-03-09T04:01:00Z"))).toBe(utc("2026-03-09T00:00:00Z"));
  });

  it("uses the actual New York day length across both DST changes", () => {
    expect(nyDayBounds(utc("2026-03-08T12:00:00Z"))).toEqual({
      start: utc("2026-03-08T05:00:00Z"), end: utc("2026-03-09T04:00:00Z"),
    });
    expect(nyDayBounds(utc("2026-11-01T12:00:00Z"))).toEqual({
      start: utc("2026-11-01T04:00:00Z"), end: utc("2026-11-02T05:00:00Z"),
    });
  });

  it("computes current streak in settlement order and ignores integrity failures", () => {
    const totals = rankTotals([
      { id: "later", closedAt: 30n, multiplePpm: 2_000_000n, realisedUsdg: 1_000_000n, excluded: false },
      { id: "first", closedAt: 10n, multiplePpm: 1_200_000n, realisedUsdg: 200_000n, excluded: false },
      { id: "fake", closedAt: 20n, multiplePpm: 5_000_000n, realisedUsdg: 9_000_000n, excluded: true },
      { id: "loss", closedAt: 25n, multiplePpm: 500_000n, realisedUsdg: -100_000n, excluded: false },
    ]);
    expect(totals).toEqual({ bestMultiplePpm: 2_000_000n, absoluteRealisedUsdg: 1_000_000n,
      streak: 1, wins: 2, losses: 1, bestWinId: "later" });
  });
});
