import type { Address } from "viem";

export type StrategyTerms = {
  active: boolean;
  weekly: boolean;
  smartPricing: boolean;
  otmBps: number;
  askBps: number;
  minAskBps: number;
  maxAskBps: number;
  maxUnits: bigint;
};

export type StrategyState = StrategyTerms & {
  currentLongId: bigint | null;
  orderId: bigint | null;
  expiry: bigint | null;
  lastRolledAt: bigint | null;
  lastStaleCancelAt: bigint | null;
  staleSpot: bigint | null;
  updatedAt: bigint;
};

export type RollerEvent =
  | { kind: "StrategySet"; strategy: StrategyTerms }
  | { kind: "StrategyStopped" }
  | { kind: "Rolled"; longId: bigint; orderId: bigint; expiry: bigint }
  | { kind: "StaleAskCancelled"; longId: bigint; orderId: bigint; spot: bigint }
  | { kind: "Repriced"; newOrderId: bigint };

export const strategyId = (writer: Address, underlying: Address): string =>
  `${writer.toLowerCase()}-${underlying.toLowerCase()}`;

export const emptyStrategy = (at: bigint): StrategyState => ({
  active: false,
  weekly: false,
  smartPricing: false,
  otmBps: 0,
  askBps: 0,
  minAskBps: 0,
  maxAskBps: 0,
  maxUnits: 0n,
  currentLongId: null,
  orderId: null,
  expiry: null,
  lastRolledAt: null,
  lastStaleCancelAt: null,
  staleSpot: null,
  updatedAt: at,
});

export function reduceStrategy(current: StrategyState, event: RollerEvent, at: bigint): StrategyState {
  switch (event.kind) {
    case "StrategySet":
      return { ...current, ...event.strategy, updatedAt: at };
    case "StrategyStopped":
      return { ...current, active: false, updatedAt: at };
    case "Rolled":
      return {
        ...current,
        currentLongId: event.longId,
        orderId: event.orderId,
        expiry: event.expiry,
        lastRolledAt: at,
        lastStaleCancelAt: null,
        staleSpot: null,
        updatedAt: at,
      };
    case "StaleAskCancelled":
      if (current.currentLongId !== event.longId || current.orderId !== event.orderId)
        throw new Error("StaleAskCancelled does not match the tracked position");
      return { ...current, orderId: null, lastStaleCancelAt: at, staleSpot: event.spot, updatedAt: at };
    case "Repriced":
      return { ...current, orderId: event.newOrderId, updatedAt: at };
  }
}
