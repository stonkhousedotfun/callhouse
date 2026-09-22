import { describe, expect, it } from "vitest";

import { autoRollerAbi } from "../../abis/v2/autoRoller";
import {
  eligibleStrategyPriceBand,
  emptyStrategy,
  reduceStrategy,
  strategyId,
  strategyPriceBand,
  trackedAutoRollerAskLive,
} from "../../lib/v2/autoRoller";

describe("AutoRoller event reduction", () => {
  it("includes every indexed roller event", () => {
    expect(autoRollerAbi.filter((item) => item.type === "event").map((item) => item.name)).toEqual(expect.arrayContaining([
      "Repriced", "Rolled", "StrategySet", "StrategyStopped", "StaleAskCancelled",
    ]));
  });

  it("applies a complete strategy, a roll, a reprice and a stop", () => {
    let row = emptyStrategy(0n);
    row = reduceStrategy(row, {
      kind: "StrategySet",
      strategy: {
        active: true, weekly: true, smartPricing: true, otmBps: 500, askBps: 100,
        minAskBps: 50, maxAskBps: 200, maxUnits: 25n,
      },
    }, 10n);
    expect(row).toMatchObject({ active: true, weekly: true, maxUnits: 25n, updatedAt: 10n });
    row = reduceStrategy(row, { kind: "Rolled", longId: 42n, orderId: 7n, expiry: 1000n }, 20n);
    expect(row).toMatchObject({ currentLongId: 42n, orderId: 7n, expiry: 1000n, lastRolledAt: 20n,
      lastRepricedAt: null, lastRepricedPrice: null, repriceCount: 0 });
    row = reduceStrategy(row, { kind: "Repriced", newOrderId: 8n, price: 2_100_000n }, 30n);
    row = reduceStrategy(row, { kind: "Repriced", newOrderId: 9n, price: 2_200_000n }, 35n);
    expect(row).toMatchObject({ orderId: 9n, lastRolledAt: 20n, lastRepricedAt: 35n,
      lastRepricedPrice: 2_200_000n, repriceCount: 2, updatedAt: 35n });
    row = reduceStrategy(row, { kind: "StrategyStopped" }, 40n);
    expect(row).toMatchObject({ active: false, orderId: 9n, lastRepricedAt: 35n, repriceCount: 2, updatedAt: 40n });
  });

  it("withdraws a stale ask without disabling or advancing its position, then resets on the next roll", () => {
    let row = { ...emptyStrategy(0n), active: true };
    row = reduceStrategy(row, { kind: "Rolled", longId: 42n, orderId: 7n, expiry: 1000n }, 20n);
    row = reduceStrategy(row, { kind: "StaleAskCancelled", longId: 42n, orderId: 7n, spot: 210_000_000n }, 30n);
    expect(row).toMatchObject({ active: true, currentLongId: 42n, expiry: 1000n, orderId: null,
      lastRolledAt: 20n, lastStaleCancelAt: 30n, staleSpot: 210_000_000n });
    expect(() => reduceStrategy(row, { kind: "StaleAskCancelled", longId: 42n, orderId: 99n, spot: 1n }, 31n)).toThrow(/tracked position/);
    row = reduceStrategy(row, { kind: "Rolled", longId: 44n, orderId: 8n, expiry: 2000n }, 1100n);
    expect(row).toMatchObject({ currentLongId: 44n, orderId: 8n, lastStaleCancelAt: null, staleSpot: null,
      lastRepricedAt: null, lastRepricedPrice: null, repriceCount: 0 });
  });

  it("expresses the inclusive contract band as exact inward-rounded USDG ticks", () => {
    expect(strategyPriceBand(212_210_000n, {
      active: true, smartPricing: true, askBps: 150, minAskBps: 30, maxAskBps: 150,
    })).toEqual({ min: 636_700n, max: 3_183_100n });
    expect(strategyPriceBand(1_000_100n, {
      active: true, smartPricing: true, askBps: 5, minAskBps: 5, maxAskBps: 5,
    })).toBeNull();
    expect(strategyPriceBand(200_000_000n, {
      active: true, smartPricing: false, askBps: 100, minAskBps: 50, maxAskBps: 200,
    })).toBeNull();
    expect(strategyPriceBand(200_000_000n, {
      active: false, smartPricing: true, askBps: 100, minAskBps: 50, maxAskBps: 200,
    })).toBeNull();
  });

  it("exposes a band only for the tracked live out-of-the-money AskWrite", () => {
    const writer = "0x00000000000000000000000000000000000000aa";
    const base = {
      writer,
      strategy: { active: true, smartPricing: true, askBps: 100, minAskBps: 50, maxAskBps: 200 },
      currentLongId: 42n,
      orderId: 7n,
      order: { orderId: 7n, maker: writer, longId: 42n, kind: "AskWrite", status: "open",
        units: 10n, filled: 0n, validUntil: 2_000n },
      series: { longId: 42n, isPut: false, strike: 220_000_000n },
      spot: 200_000_000n,
      tradingPaused: false,
      delegateApproved: true,
      now: 1_000n,
    };
    expect(trackedAutoRollerAskLive(base)).toBe(true);
    expect(eligibleStrategyPriceBand(base)).toEqual({ min: 1_000_000n, max: 4_000_000n });
    expect(eligibleStrategyPriceBand({ ...base, strategy: { ...base.strategy, active: false } })).toBeNull();
    expect(eligibleStrategyPriceBand({ ...base, orderId: null })).toBeNull();
    expect(eligibleStrategyPriceBand({ ...base,
      order: { ...base.order, status: "cancelled" } })).toBeNull();
    expect(eligibleStrategyPriceBand({ ...base,
      order: { ...base.order, filled: base.order.units } })).toBeNull();
    expect(eligibleStrategyPriceBand({ ...base,
      order: { ...base.order, validUntil: base.now } })).toBeNull();
    expect(eligibleStrategyPriceBand({ ...base, tradingPaused: true })).toBeNull();
    expect(eligibleStrategyPriceBand({ ...base, delegateApproved: false })).toBeNull();
    expect(eligibleStrategyPriceBand({ ...base, spot: base.series.strike })).toBeNull();
    expect(eligibleStrategyPriceBand({ ...base, series: { ...base.series, isPut: true, strike: 200_000_000n },
      spot: 199_999_999n })).toBeNull();
  });

  it("normalizes the strategy key", () => {
    expect(strategyId("0xAA" as `0x${string}`, "0xBB" as `0x${string}`)).toBe("0xaa-0xbb");
  });
});
