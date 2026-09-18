import { describe, expect, it } from "vitest";
import { fairAtFill, isOffMarket, nearbyVwap } from "../../lib/v2/integrity";
import { buyPosition, closePosition, emptyPosition, isWin, redeemPosition, sellPosition } from "../../lib/v2/pnl";

describe("v2 realised long PnL and feed integrity", () => {
  it("includes taker-paid cost in the multiple and marks only closed profitable positions", () => {
    const bought = buyPosition(emptyPosition(), 10n, 1_100_000n);
    const sold = sellPosition(bought, 4n, 800_000n, 440_000n, false);
    const redeemed = redeemPosition(sold, 6n, 1_200_000n, 660_000n, false);
    expect(redeemed).toMatchObject({ costUsdg: 1_100_000n, realisedUsdg: 900_000n, multiplePpm: 1_818_181n });
    expect(isWin(redeemed)).toBe(false);
    const closed = closePosition(redeemed, 200n);
    expect(closed.multiple).toBe("1.818181");
    expect(isWin(closed)).toBe(true);
  });

  it("excludes self fills, tiny cost and free transferred lots", () => {
    expect(isWin(closePosition(redeemPosition(buyPosition(emptyPosition(), 1n, 50_000n), 1n, 2_000_000n, 50_000n, false), 2n))).toBe(false);
    expect(isWin(closePosition(redeemPosition(buyPosition(emptyPosition(), 1n, 500_000n, true), 1n, 2_000_000n, 500_000n, false), 2n))).toBe(false);
    expect(isWin(closePosition(redeemPosition(buyPosition(emptyPosition(), 1n, 500_000n), 1n, 2_000_000n, 500_000n, true), 2n))).toBe(false);
    expect(isWin(closePosition(redeemPosition(buyPosition(emptyPosition(), 1n, 500_000n, false, true), 1n, 2_000_000n, 500_000n, false), 2n))).toBe(false);
  });

  it("uses fill-time fair, falls back to other takers and does not invent a flag without either", () => {
    expect(fairAtFill({ fair: 1_000_000n, asOf: 100n }, 3700n)).toBe(1_000_000n); // boundary
    expect(fairAtFill({ fair: 1_000_000n, asOf: 100n }, 3701n)).toBe(null);
    const vwap = nearbyVwap([
      { taker: "alice", ts: 100n, units: 10n, premium: 100_000n },
      { taker: "bob", ts: 101n, units: 10n, premium: 200_000n },
      { taker: "bob", ts: 4000n, units: 10n, premium: 900_000n },
    ], "alice", 100n);
    expect(vwap).toBe(2_000_000n);
    expect(isOffMarket(499_900n, vwap)).toBe(true);
    expect(isOffMarket(500_000n, vwap)).toBe(false);
    expect(isOffMarket(1n, null)).toBe(false);
  });
});
