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
  lastRepricedAt: bigint | null;
  lastRepricedPrice: bigint | null;
  repriceCount: number;
  lastStaleCancelAt: bigint | null;
  staleSpot: bigint | null;
  updatedAt: bigint;
};

export type RollerEvent =
  | { kind: "StrategySet"; strategy: StrategyTerms }
  | { kind: "StrategyStopped" }
  | { kind: "Rolled"; longId: bigint; orderId: bigint; expiry: bigint }
  | { kind: "StaleAskCancelled"; longId: bigint; orderId: bigint; spot: bigint }
  | { kind: "Repriced"; newOrderId: bigint; price: bigint };

const BPS = 10_000n;
const PRICE_TICK = 100n;
const MIN_ASK_BPS = 5;
const MAX_ASK_BPS = 1_000;

const ceilDiv = (value: bigint, divisor: bigint): bigint => (value + divisor - 1n) / divisor;

/** Exact tick-aligned price interval accepted by AutoRoller.reprice at this oracle spot. */
export function strategyPriceBand(
  spot: bigint,
  strategy: Pick<StrategyTerms, "active" | "smartPricing" | "askBps" | "minAskBps" | "maxAskBps">,
): { min: bigint; max: bigint } | null {
  if (!strategy.active || !strategy.smartPricing || spot <= 0n ||
      ![strategy.askBps, strategy.minAskBps, strategy.maxAskBps].every(Number.isInteger) ||
      strategy.minAskBps < MIN_ASK_BPS || strategy.maxAskBps > MAX_ASK_BPS ||
      strategy.minAskBps > strategy.askBps || strategy.askBps > strategy.maxAskBps) return null;
  const min = ceilDiv(ceilDiv(spot * BigInt(strategy.minAskBps), BPS), PRICE_TICK) * PRICE_TICK;
  const max = (spot * BigInt(strategy.maxAskBps) / BPS) / PRICE_TICK * PRICE_TICK;
  return min > 0n && min <= max ? { min, max } : null;
}

export type IndexedAutoRollerOrder = {
  orderId: bigint;
  maker: string;
  longId: bigint;
  kind: string;
  status: string;
  units: bigint;
  filled: bigint;
  validUntil: bigint;
};

export type IndexedAutoRollerSeries = {
  longId: bigint;
  isPut: boolean;
  strike: bigint;
};

/** Whether the indexed order is the live AskWrite tracked by the current AutoRoller position. */
export function trackedAutoRollerAskLive(input: {
  writer: string;
  currentLongId: bigint | null;
  orderId: bigint | null;
  order: IndexedAutoRollerOrder | undefined;
  now: bigint;
}): input is typeof input & { currentLongId: bigint; orderId: bigint; order: IndexedAutoRollerOrder } {
  const { currentLongId, orderId, order } = input;
  return currentLongId !== null && currentLongId > 0n && orderId !== null && orderId > 0n &&
    order !== undefined && order.orderId === orderId && order.longId === currentLongId &&
    order.maker.toLowerCase() === input.writer.toLowerCase() && order.kind === "AskWrite" &&
    order.status === "open" && order.filled < order.units && input.now < order.validUntil;
}

/**
 * Reprice band for a currently eligible indexed position. Contract-global conditions such as the
 * caller's PRICER_ROLE are outside this per-strategy projection; all event-derived strategy,
 * position, order, pause, delegation, spot and in-the-money refusals are enforced here.
 */
export function eligibleStrategyPriceBand(input: {
  writer: string;
  strategy: Pick<StrategyTerms, "active" | "smartPricing" | "askBps" | "minAskBps" | "maxAskBps">;
  currentLongId: bigint | null;
  orderId: bigint | null;
  order: IndexedAutoRollerOrder | undefined;
  series: IndexedAutoRollerSeries | undefined;
  spot: bigint | null;
  tradingPaused: boolean;
  delegateApproved: boolean;
  now: bigint;
}): { min: bigint; max: bigint } | null {
  if (input.tradingPaused || !input.delegateApproved || input.spot === null || input.series === undefined ||
      !trackedAutoRollerAskLive(input) || input.series.longId !== input.currentLongId) return null;
  const overtaken = input.series.isPut
    ? input.spot <= input.series.strike
    : input.spot >= input.series.strike;
  return overtaken ? null : strategyPriceBand(input.spot, input.strategy);
}

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
  lastRepricedAt: null,
  lastRepricedPrice: null,
  repriceCount: 0,
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
        lastRepricedAt: null,
        lastRepricedPrice: null,
        repriceCount: 0,
        lastStaleCancelAt: null,
        staleSpot: null,
        updatedAt: at,
      };
    case "StaleAskCancelled":
      if (current.currentLongId !== event.longId || current.orderId !== event.orderId)
        throw new Error("StaleAskCancelled does not match the tracked position");
      return { ...current, orderId: null, lastStaleCancelAt: at, staleSpot: event.spot, updatedAt: at };
    case "Repriced":
      return {
        ...current,
        orderId: event.newOrderId,
        lastRepricedAt: at,
        lastRepricedPrice: event.price,
        repriceCount: current.repriceCount + 1,
        updatedAt: at,
      };
  }
}
