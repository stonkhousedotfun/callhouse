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
  /** The last PositionClosed. It outlives the position it describes; the next close overwrites it. */
  lastClosedAt: bigint | null;
  lastClosedLongId: bigint | null;
  /** The ask the roller still tracked at close-out; null when the event carried 0 (stop or cancelStale dropped it). */
  lastClosedOrderId: bigint | null;
  lastCloseRedeemed: boolean | null;
  updatedAt: bigint;
};

export type RollerEvent =
  | { kind: "StrategySet"; strategy: StrategyTerms }
  | { kind: "StrategyStopped" }
  | { kind: "Rolled"; longId: bigint; orderId: bigint; expiry: bigint }
  | { kind: "StaleAskCancelled"; longId: bigint; orderId: bigint; spot: bigint }
  | { kind: "Repriced"; newOrderId: bigint; price: bigint }
  | { kind: "PositionClosed"; longId: bigint; orderId: bigint; redeemed: boolean };

const BPS = 10_000n;
const PRICE_TICK = 100n;
// AutoRoller.MIN_ASK_BPS / MAX_ASK_BPS (AutoRoller.sol:152-153). A change raised the floor from 5 to 50 before the v8 deploy;
// ops/v2/contract-mirrors.list.mjs pins both against the contracts.
const MIN_ASK_BPS = 50;
const MAX_ASK_BPS = 1_000;
// AutoRoller.MAX_REPRICE_DROP_BPS (AutoRoller.sol:162, a compiled constant): one reprice may not go below
// `current x (BPS - MAX_REPRICE_DROP_BPS) / BPS` (RepriceDropExceeded, :504).
export const MAX_REPRICE_DROP_BPS = 2_500;

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
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: bigint;
};

/**
 * The lowest price `reprice` accepts against the ask it replaces: AutoRoller.sol:504 reverts
 * RepriceDropExceeded when `newPrice x BPS < current x (BPS - MAX_REPRICE_DROP_BPS)`, and a price must sit on the tick,
 * so the floor is that bound rounded up to the tick -- the same figure the revert reports as its third argument.
 */
export function repriceDropFloor(current: bigint): bigint {
  return ceilDiv(ceilDiv(current * (BPS - BigInt(MAX_REPRICE_DROP_BPS)), BPS), PRICE_TICK) * PRICE_TICK;
}

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
  if (overtaken) return null;
  const band = strategyPriceBand(input.spot, input.strategy);
  if (band === null) return null;
  // The spot band alone let `min` fall below the drop floor, and a reprice there reverts.
  const floor = repriceDropFloor(input.order.price);
  const min = band.min > floor ? band.min : floor;
  return min <= band.max ? { min, max: band.max } : null;
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
  lastClosedAt: null,
  lastClosedLongId: null,
  lastClosedOrderId: null,
  lastCloseRedeemed: null,
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
    case "PositionClosed":
      // AutoRoller._closeOut deletes the whole position and emits this (IAutoRoller.PositionClosed), so the
      // row keeps no current position, order or expiry, and drops the reprice and stale-cancel state that belonged to
      // it. Unlike StaleAskCancelled this never refuses a mismatch: the contract has already cleared the position, so
      // a replay that began after its Rolled (currentLongId null) still ends where the chain is.
      return {
        ...current,
        currentLongId: null,
        orderId: null,
        expiry: null,
        lastRepricedAt: null,
        lastRepricedPrice: null,
        repriceCount: 0,
        lastStaleCancelAt: null,
        staleSpot: null,
        lastClosedAt: at,
        lastClosedLongId: event.longId,
        lastClosedOrderId: event.orderId === 0n ? null : event.orderId,
        lastCloseRedeemed: event.redeemed,
        updatedAt: at,
      };
  }
}
