import { describe, expect, it } from "vitest";

import { autoRollerAbi } from "../../abis/v2/autoRoller";
import { emptyStrategy, reduceStrategy, strategyId } from "../../lib/v2/autoRoller";

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
    expect(row).toMatchObject({ currentLongId: 42n, orderId: 7n, expiry: 1000n, lastRolledAt: 20n });
    row = reduceStrategy(row, { kind: "Repriced", newOrderId: 8n }, 30n);
    expect(row).toMatchObject({ orderId: 8n, lastRolledAt: 20n, updatedAt: 30n });
    row = reduceStrategy(row, { kind: "StrategyStopped" }, 40n);
    expect(row).toMatchObject({ active: false, orderId: 8n, updatedAt: 40n });
  });

  it("withdraws a stale ask without disabling or advancing its position, then resets on the next roll", () => {
    let row = { ...emptyStrategy(0n), active: true };
    row = reduceStrategy(row, { kind: "Rolled", longId: 42n, orderId: 7n, expiry: 1000n }, 20n);
    row = reduceStrategy(row, { kind: "StaleAskCancelled", longId: 42n, orderId: 7n, spot: 210_000_000n }, 30n);
    expect(row).toMatchObject({ active: true, currentLongId: 42n, expiry: 1000n, orderId: null,
      lastRolledAt: 20n, lastStaleCancelAt: 30n, staleSpot: 210_000_000n });
    expect(() => reduceStrategy(row, { kind: "StaleAskCancelled", longId: 42n, orderId: 99n, spot: 1n }, 31n)).toThrow(/tracked position/);
    row = reduceStrategy(row, { kind: "Rolled", longId: 44n, orderId: 8n, expiry: 2000n }, 1100n);
    expect(row).toMatchObject({ currentLongId: 44n, orderId: 8n, lastStaleCancelAt: null, staleSpot: null });
  });

  it("normalizes the strategy key", () => {
    expect(strategyId("0xAA" as `0x${string}`, "0xBB" as `0x${string}`)).toBe("0xaa-0xbb");
  });
});
