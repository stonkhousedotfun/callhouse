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
      "Repriced", "Rolled", "StrategySet", "StrategyStopped", "StaleAskCancelled", "PositionClosed",
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

  it("closes the position on PositionClosed, records what it closed, and keeps that record past the next roll", () => {
    let row = { ...emptyStrategy(0n), active: true };
    row = reduceStrategy(row, { kind: "Rolled", longId: 42n, orderId: 7n, expiry: 1000n }, 20n);
    row = reduceStrategy(row, { kind: "Repriced", newOrderId: 9n, price: 2_200_000n }, 35n);
    row = reduceStrategy(row, { kind: "StaleAskCancelled", longId: 42n, orderId: 9n, spot: 210_000_000n }, 40n);
    // cancelStale dropped the ask, so the close-out carries orderId 0.
    row = reduceStrategy(row, { kind: "PositionClosed", longId: 42n, orderId: 0n, redeemed: true }, 1100n);
    expect(row).toMatchObject({ active: true, currentLongId: null, orderId: null, expiry: null, lastRolledAt: 20n,
      lastRepricedAt: null, lastRepricedPrice: null, repriceCount: 0, lastStaleCancelAt: null, staleSpot: null,
      lastClosedAt: 1100n, lastClosedLongId: 42n, lastClosedOrderId: null, lastCloseRedeemed: true, updatedAt: 1100n });
    row = reduceStrategy(row, { kind: "Rolled", longId: 44n, orderId: 8n, expiry: 2000n }, 1200n);
    expect(row).toMatchObject({ currentLongId: 44n, orderId: 8n, expiry: 2000n,
      lastClosedAt: 1100n, lastClosedLongId: 42n, lastClosedOrderId: null, lastCloseRedeemed: true });
    // A close that still tracked its ask names it; one whose asks never filled did not redeem.
    row = reduceStrategy(row, { kind: "PositionClosed", longId: 44n, orderId: 8n, redeemed: false }, 2100n);
    expect(row).toMatchObject({ currentLongId: null, orderId: null, expiry: null,
      lastClosedAt: 2100n, lastClosedLongId: 44n, lastClosedOrderId: 8n, lastCloseRedeemed: false });
  });

  it("applies a PositionClosed whose Rolled predates a bounded replay instead of refusing it", () => {
    // The contract has already cleared the position; refusing here would stall the indexer, not protect it.
    const row = reduceStrategy(emptyStrategy(0n), { kind: "PositionClosed", longId: 42n, orderId: 7n, redeemed: true }, 50n);
    expect(row).toMatchObject({ currentLongId: null, orderId: null, lastClosedAt: 50n, lastClosedLongId: 42n,
      lastClosedOrderId: 7n, lastCloseRedeemed: true });
  });

  it("expresses the inclusive contract band as exact inward-rounded USDG ticks", () => {
    expect(strategyPriceBand(212_210_000n, {
      active: true, smartPricing: true, askBps: 150, minAskBps: 50, maxAskBps: 150,
    })).toEqual({ min: 1_061_100n, max: 3_183_100n });
    // AutoRoller.MIN_ASK_BPS = 50: a band under the floor is not one setStrategy accepts.
    expect(strategyPriceBand(212_210_000n, {
      active: true, smartPricing: true, askBps: 150, minAskBps: 49, maxAskBps: 150,
    })).toBeNull();
    expect(strategyPriceBand(1_000_100n, {
      active: true, smartPricing: true, askBps: 50, minAskBps: 50, maxAskBps: 50,
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
      // price: the ask being repriced; its drop floor (750_000) sits below this band's min, so the band is the spot band.
      order: { orderId: 7n, maker: writer, longId: 42n, kind: "AskWrite", status: "open", price: 1_000_000n,
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
