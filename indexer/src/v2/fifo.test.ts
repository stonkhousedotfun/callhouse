import { describe, expect, it } from "vitest";
import { consumeFifo, feeShares, payoutValueUsdg } from "../../lib/v2/fifo";

describe("v2 FIFO long cost basis", () => {
  it("spends oldest units, preserves rounding dust, and marks plain transfer inventory", () => {
    const lots = [
      { seq: 0, unitsRemaining: 3n, costRemainingUsdg: 10n, source: "fill" as const },
      { seq: 1, unitsRemaining: 2n, costRemainingUsdg: 0n, source: "transfer" as const },
      { seq: 2, unitsRemaining: 2n, costRemainingUsdg: 20n, source: "fill" as const },
    ];
    const first = consumeFifo(lots, 2n);
    expect(first).toMatchObject({ costUsdg: 6n, transferIn: false });
    expect(first.consumed.map((c) => [c.lot.seq, c.units, c.costUsdg])).toEqual([[0, 2n, 6n]]);
    lots[0]!.unitsRemaining -= 2n;
    lots[0]!.costRemainingUsdg -= 6n;
    const second = consumeFifo(lots, 4n);
    expect(second.consumed.map((c) => [c.lot.seq, c.units, c.costUsdg])).toEqual([
      [0, 1n, 4n], [1, 2n, 0n], [2, 1n, 10n],
    ]);
    expect(second.costUsdg).toBe(14n);
    expect(second.transferIn).toBe(true);
    expect(() => consumeFifo(lots, 8n)).toThrow(/short by/);
  });

  it("allocates a ticket fee across makers without dropping the remainder", () => {
    expect(feeShares([{ premium: 10n }, { premium: 20n }, { premium: 30n }], 7n)).toEqual([1n, 2n, 4n]);
    expect(feeShares([{ premium: 0n }], 0n)).toEqual([0n]);
    expect(() => feeShares([], 1n)).toThrow(/without fills/);
  });

  it("values Stock Token deliveries at settlement and USDG deliveries at their actual amount", () => {
    expect(payoutValueUsdg(5n * 10n ** 17n, 200_000_000n, false)).toBe(100_000_000n);
    expect(payoutValueUsdg(80_000_000n, 200_000_000n, true)).toBe(80_000_000n);
  });
});
