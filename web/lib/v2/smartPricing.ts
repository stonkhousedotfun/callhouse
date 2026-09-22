import type { Market, StrategiesResponse } from "./api-types";

const BPS = 10_000n;
const PRICE_TICK = 100n;
const USDG_SCALE = 1_000_000n;

export const MIN_ASK_BPS = 5;
export const MAX_ASK_BPS = 1_000;
export const SMART_PRICING_REVIEW_MS = 60_000;
export const COMPLETE_CALL_LIST_ERROR = "The complete call list could not be refreshed. Manual asks remain available; retry when market data recovers.";

export type IndexedStrategy = StrategiesResponse["items"][number];

export type PortfolioPricingStatus = {
  kind: "legacy" | "no-live-order" | "withdrawn" | "price-unavailable" |
    "band-unavailable" | "in-band" | "clamped-minimum" | "clamped-maximum" | "outside-band";
  label: string;
};

/**
 * Portfolio's `/v2/strategies` query is global, so ticker alone is never an ownership join.
 * Keep only rows for the connected writer whose underlying is the one registered for that
 * market. A same-ticker row for another wallet or asset is deliberately ignored.
 */
export function selectPortfolioSmartPricingStrategies(
  rows: readonly IndexedStrategy[],
  writer: string,
  markets: readonly Market[],
): IndexedStrategy[] {
  const owner = writer.toLowerCase();
  const marketKeys = new Set(markets.map((market) =>
    `${market.ticker.toUpperCase()}:${market.underlying.toLowerCase()}`));
  return rows.filter((row) => row.strategy.active && row.strategy.smartPricing &&
    row.writer.toLowerCase() === owner &&
    marketKeys.has(`${row.ticker.toUpperCase()}:${row.underlying.toLowerCase()}`));
}

/** Describe the indexed order state without collapsing missing legacy data into a zero. */
export function portfolioPricingStatus(row: IndexedStrategy): PortfolioPricingStatus {
  if (row.pricing === undefined) return { kind: "legacy", label: "Pricing state not reported" };
  if (row.orderId === null) return row.lastStaleCancelAt !== null
    ? { kind: "withdrawn", label: "Withdrawn" }
    : { kind: "no-live-order", label: "No live order" };
  if (row.pricing.currentAsk === null) return { kind: "price-unavailable", label: "Live ask unavailable" };
  if (row.pricing.band === null) return { kind: "band-unavailable", label: "Band unavailable" };
  const ask = BigInt(row.pricing.currentAsk.raw);
  const minimum = BigInt(row.pricing.band.min.raw);
  const maximum = BigInt(row.pricing.band.max.raw);
  if (ask === minimum) return { kind: "clamped-minimum", label: "Clamped at minimum" };
  if (ask === maximum) return { kind: "clamped-maximum", label: "Clamped at maximum" };
  if (ask > minimum && ask < maximum) return { kind: "in-band", label: "In band" };
  return { kind: "outside-band", label: "Outside indexed band" };
}

/*//////////////////////////////////////////////////////////////
        W3-301: SMART PRICING IS ONLY OFFERED WHEN THE PRICER IS ALIVE
//////////////////////////////////////////////////////////////*/

/**
 * Whether the smart-pricing control may be OFFERED, decided from the indexer's `/v2/services`
 * reading of the pricer.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE `services.data?.pricer.healthy` AT THE CALL SITE.
 * Every way of NOT knowing has to land on "not offered", and there are five of them: the request
 * has not answered yet, the request failed, the field is absent because the indexer is older than
 * the route, the reading is stale, and the pricer said no. Spread across a component those five
 * become five `?.` chains, and the one that gets forgotten defaults to `undefined`, which is falsy
 * in a boolean test and truthy in a `!== false` test. Naming the decision once means a test can
 * enumerate the five and assert the answer is the same for all of them.
 *
 * FAIL CLOSED IS THE WHOLE POINT. `offered` is true only when a reading exists AND says
 * `healthy: true`. Nothing else — not a pending query, not a thrown request, not a `healthy` field
 * that arrived as a string, not an unreadable body — can reach true. That is AC4: a control that
 * stays on because the health probe itself broke is the defect class this board has hit repeatedly,
 * a check reading as green because it cannot see its subject.
 */
export type PricerReading = {
  healthy: boolean;
  reason: string;
  checkedAt: number;
} | null | undefined;

export type SmartPricingOffer = {
  /** True only when the pricer is known-healthy. Every other state is false. */
  offered: boolean;
  /** Plain sentence for the user when it is not offered. Empty string when it is. */
  note: string;
};

/** Said when the pricer is known to be down, as distinct from not yet known. */
export const SMART_PRICING_PRICER_DOWN =
  "Smart pricing is unavailable because the pricing service is not running. You can still set a fixed ask, and any ask already live stays live at its last price.";
/** Said while the reading has not arrived, or could not be read at all. */
export const SMART_PRICING_PRICER_UNKNOWN =
  "Smart pricing is unavailable because the pricing service could not be checked. You can still set a fixed ask, and any ask already live stays live at its last price.";

/**
 * A reading older than this no longer describes the present, so it is treated as not knowing.
 *
 * Deliberately longer than the indexer's own freshness bound: `/v2/services` already answers
 * `reason: "stale"` on its side, and this is the second line of defence for the case where the
 * whole response is old — a cached page, a resumed tab, a query that stopped refetching. Both
 * failures land on `offered: false`; they differ only in which note is shown.
 */
export const PRICER_READING_MAX_AGE_SECONDS = 120;

/**
 * `reading` is the `pricer` object from `/v2/services`, `undefined` while the query is pending,
 * and `null` when the query failed. `nowSeconds` is passed in so staleness is testable without a
 * clock.
 */
export function smartPricingOffer(reading: PricerReading, nowSeconds: number): SmartPricingOffer {
  // Not knowing is not healthy. Pending and failed are the same answer to the user, because the
  // question "may I offer this control" has the same answer in both.
  if (reading === null || reading === undefined) return { offered: false, note: SMART_PRICING_PRICER_UNKNOWN };
  // Defensive against a field that arrived with the wrong type despite the schema: a `healthy`
  // that is not exactly `true` is not healthy. `!== false` would let `undefined` through.
  if (typeof reading.healthy !== "boolean" || typeof reading.checkedAt !== "number"
    || !Number.isFinite(reading.checkedAt)) return { offered: false, note: SMART_PRICING_PRICER_UNKNOWN };
  if (nowSeconds - reading.checkedAt > PRICER_READING_MAX_AGE_SECONDS) {
    return { offered: false, note: SMART_PRICING_PRICER_UNKNOWN };
  }
  if (reading.healthy !== true) return { offered: false, note: SMART_PRICING_PRICER_DOWN };
  return { offered: true, note: "" };
}

const ceilDiv = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;
const roundUpToTick = (value: bigint) => ceilDiv(value, PRICE_TICK) * PRICE_TICK;
const roundDownToTick = (value: bigint) => value / PRICE_TICK * PRICE_TICK;

export type SmartPricingReference = {
  expiry: number;
  strike: bigint;
  tenor: "daily" | "weekly";
  status: string;
};

/**
 * Run a complete-list read for each user action and never substitute older cached rows after a
 * failed refresh. Keeping the refresh behind a callback also makes recovery after an earlier
 * failure explicit and testable without restoring background polling or retries.
 */
export async function refreshSmartPricingRows<T>(
  refresh: () => Promise<{ items: T[] | null; error?: unknown }>,
): Promise<T[]> {
  try {
    const result = await refresh();
    if (result.error || result.items === null) throw new Error(COMPLETE_CALL_LIST_ERROR);
    return result.items;
  } catch (error) {
    if (error instanceof Error && error.message === COMPLETE_CALL_LIST_ERROR) throw error;
    throw new Error(COMPLETE_CALL_LIST_ERROR, { cause: error });
  }
}

/**
 * Use a farther-dated option as the pricing reference so a nearly expired option's collapsing
 * premium does not silently narrow every future roll. Within that expiry, use the strike nearest
 * the strategy target. The caller retains the full row through the generic return type.
 */
export function selectSmartPricingReference<T extends SmartPricingReference>(
  rows: readonly T[],
  weekly: boolean,
  targetStrike: bigint,
): T | null {
  const tenor = weekly ? "weekly" : "daily";
  const open = rows.filter((row) => row.status === "open" && row.tenor === tenor && row.expiry > 0);
  if (!open.length) return null;
  const expiry = Math.max(...open.map((row) => row.expiry));
  return open.filter((row) => row.expiry === expiry).sort((a, b) => {
    const aDistance = a.strike > targetStrike ? a.strike - targetStrike : targetStrike - a.strike;
    const bDistance = b.strike > targetStrike ? b.strike - targetStrike : targetStrike - b.strike;
    return aDistance < bDistance ? -1 : aDistance > bDistance ? 1 : a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0;
  })[0] ?? null;
}

export function autoRollTargetStrike(spot: bigint, otmBps: number, strikeTick: bigint): bigint | null {
  if (spot <= 0n || strikeTick <= 0n || !Number.isInteger(otmBps) || otmBps < 100 || otmBps > 2_500) return null;
  const raw = ceilDiv(spot * BigInt(10_000 + otmBps), BPS);
  return ceilDiv(raw, strikeTick) * strikeTick;
}

export type ProposedSmartPricingBand = {
  referenceBps: number;
  askBps: number;
  minAskBps: number;
  maxAskBps: number;
};

/**
 * Candidate only: reference / 4 through max(3 x reference, reference + 25 bps), capped to
 * AutoRoller's 5..1,000 bps contract range, with the initial ask at the ceiling.
 */
export function proposedSmartPricingBand(spot: bigint, referenceFair: bigint | null): ProposedSmartPricingBand | null {
  if (spot <= 0n || referenceFair === null || referenceFair <= 0n) return null;
  const referenceBps = referenceFair * BPS / spot;
  const proposedMax = referenceBps * 3n > referenceBps + 25n ? referenceBps * 3n : referenceBps + 25n;
  const maxAskBps = Number(proposedMax > BigInt(MAX_ASK_BPS) ? BigInt(MAX_ASK_BPS) : proposedMax);
  const proposedMin = referenceBps / 4n > BigInt(MIN_ASK_BPS) ? referenceBps / 4n : BigInt(MIN_ASK_BPS);
  const minAskBps = Number(proposedMin > BigInt(maxAskBps) ? BigInt(maxAskBps) : proposedMin);
  return {
    referenceBps: Number(referenceBps > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : referenceBps),
    askBps: maxAskBps,
    minAskBps,
    maxAskBps,
  };
}

export type SmartPricingPrices = { start: bigint; min: bigint; max: bigint };

export type StrategyPriceField = "start" | "minimum" | "maximum";

/** The exact USDG6/share price that each AutoRoller field produces at the supplied spot. */
export function strategyPriceAtBps(spot: bigint, bps: number, field: StrategyPriceField): bigint | null {
  if (spot <= 0n || !Number.isInteger(bps) || bps < MIN_ASK_BPS || bps > MAX_ASK_BPS) return null;
  return field === "maximum"
    ? roundDownToTick(spot * BigInt(bps) / BPS)
    : roundUpToTick(ceilDiv(spot * BigInt(bps), BPS));
}

export function autoRollStartPrice(spot: bigint, askBps: number): bigint | null {
  return strategyPriceAtBps(spot, askBps, "start");
}

/**
 * USDG6/share prices implied by the strategy at the current spot. The limits mirror the pricer's
 * inward tick rounding; the initial AutoRoller ask rounds up to the 0.0001 USDG order-book tick.
 */
export function smartPricingPrices(
  spot: bigint,
  strategy: { askBps: number; minAskBps: number; maxAskBps: number },
): SmartPricingPrices | null {
  const { askBps, minAskBps, maxAskBps } = strategy;
  if (spot <= 0n || ![askBps, minAskBps, maxAskBps].every(Number.isInteger) ||
      minAskBps < MIN_ASK_BPS || maxAskBps > MAX_ASK_BPS || minAskBps > askBps || askBps > maxAskBps)
    return null;
  const min = roundUpToTick(ceilDiv(spot * BigInt(minAskBps), BPS));
  const max = roundDownToTick(spot * BigInt(maxAskBps) / BPS);
  if (min <= 0n || min > max) return null;
  return { start: autoRollStartPrice(spot, askBps)!, min, max };
}

/** Parse a positive USDG/share input with no precision beyond the OrderBook's 0.0001 USDG tick. */
export function parseUsdgTick(value: string): bigint | null {
  const trimmed = value.trim();
  if (trimmed.length > 32) return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{0,4}))?$/.exec(trimmed);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(6, "0");
  const raw = BigInt(match[1]) * USDG_SCALE + BigInt(fraction || "0");
  return raw > 0n && raw % PRICE_TICK === 0n ? raw : null;
}

export function formatUsdgTick(value: bigint): string {
  if (value <= 0n || value % PRICE_TICK !== 0n) throw new RangeError("USDG price must use the 0.0001 tick.");
  const whole = value / USDG_SCALE;
  const fraction = (value % USDG_SCALE).toString().padStart(6, "0").slice(0, 4).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export type SnappedStrategyPrice = { bps: number; price: bigint };

/**
 * Convert one committed USDG tick to contract bps. AutoRoller cannot store fractional bps, so an
 * in-between value snaps to the first contract price at or above what the writer typed. That
 * direction never turns a writer's ask or limit into a cheaper price.
 */
export function snapStrategyPriceToBps(
  spot: bigint,
  price: bigint,
  field: StrategyPriceField,
): SnappedStrategyPrice | null {
  if (spot <= 0n || price <= 0n || price % PRICE_TICK !== 0n) return null;
  for (let bps = MIN_ASK_BPS; bps <= MAX_ASK_BPS; bps += 1) {
    const candidate = strategyPriceAtBps(spot, bps, field)!;
    if (candidate >= price) return { bps, price: candidate };
  }
  return null;
}

/** A fixed strategy uses the live reference itself, rounded only in the writer's favour. */
export function fixedAskBpsFromReference(spot: bigint, referenceFair: bigint | null): number | null {
  if (referenceFair === null || referenceFair <= 0n) return null;
  return snapStrategyPriceToBps(spot, roundUpToTick(referenceFair), "start")?.bps ?? null;
}

/**
 * Turn smart pricing on without inheriting hidden 0/0 limits from a fixed strategy. Prefer the
 * reviewed proposal; otherwise use the narrowest contract-valid band around the current ask.
 */
export function smartPricingDraft(
  spot: bigint,
  current: { askBps: number; minAskBps: number; maxAskBps: number },
  proposal: ProposedSmartPricingBand | null,
): { askBps: number; minAskBps: number; maxAskBps: number } | null {
  if (proposal && smartPricingPrices(spot, proposal)) return {
    askBps: proposal.askBps,
    minAskBps: proposal.minAskBps,
    maxAskBps: proposal.maxAskBps,
  };
  if (smartPricingPrices(spot, current)) return current;
  if (!Number.isInteger(current.askBps) || current.askBps < MIN_ASK_BPS || current.askBps > MAX_ASK_BPS) return null;
  for (let spread = 0; spread <= MAX_ASK_BPS - MIN_ASK_BPS; spread += 1) {
    const minAskBps = Math.max(MIN_ASK_BPS, current.askBps - spread);
    const maxAskBps = Math.min(MAX_ASK_BPS, current.askBps + spread);
    const candidate = { askBps: current.askBps, minAskBps, maxAskBps };
    if (smartPricingPrices(spot, candidate)) return candidate;
  }
  return null;
}

export type PricingRequestSnapshot = {
  ticker: string;
  underlying: string;
  revision: number;
  spot: bigint;
  strikeTick: bigint;
  weekly: boolean;
  otmBps: number;
  smartPricing: boolean;
};

export type SmartPricingCandidateContext = {
  ticker: string;
  underlying: string;
  spot: bigint;
  strikeTick: bigint;
  weekly: boolean;
  otmBps: number;
  revision: number;
};

export type SmartPricingCandidateSnapshot = SmartPricingCandidateContext & { reviewedAtMs: number };
export type SmartPricingCandidateState = "current" | "expired" | "changed";

/** A reviewed proposal is short-lived and belongs to one exact market/form snapshot. */
export function smartPricingCandidateState(
  candidate: SmartPricingCandidateSnapshot,
  current: SmartPricingCandidateContext,
  nowMs: number,
): SmartPricingCandidateState {
  if (candidate.ticker.toUpperCase() !== current.ticker.toUpperCase() ||
      candidate.underlying.toLowerCase() !== current.underlying.toLowerCase() ||
      candidate.spot !== current.spot || candidate.strikeTick !== current.strikeTick ||
      candidate.weekly !== current.weekly || candidate.otmBps !== current.otmBps ||
      candidate.revision !== current.revision)
    return "changed";
  if (!Number.isSafeInteger(candidate.reviewedAtMs) || !Number.isSafeInteger(nowMs) ||
      nowMs < candidate.reviewedAtMs)
    return "changed";
  return nowMs - candidate.reviewedAtMs >= SMART_PRICING_REVIEW_MS ? "expired" : "current";
}

/** Guard an asynchronous Fill result against any intervening form or market change. */
export function pricingRequestIsCurrent(
  requested: PricingRequestSnapshot,
  current: PricingRequestSnapshot,
): boolean {
  return requested.ticker.toUpperCase() === current.ticker.toUpperCase() &&
    requested.underlying.toLowerCase() === current.underlying.toLowerCase() &&
    requested.revision === current.revision && requested.spot === current.spot &&
    requested.strikeTick === current.strikeTick && requested.weekly === current.weekly &&
    requested.otmBps === current.otmBps && requested.smartPricing === current.smartPricing;
}

/** Recheck the exact reviewed form and candidate at the strategy-write boundary. */
export function pricingWriteState(
  requested: PricingRequestSnapshot,
  current: PricingRequestSnapshot,
  candidate: SmartPricingCandidateSnapshot | null,
  nowMs: number,
  marketLive: boolean,
): "current" | SmartPricingCandidateState {
  if (!marketLive || !pricingRequestIsCurrent(requested, current)) return "changed";
  if (!requested.smartPricing || candidate === null) return "current";
  return smartPricingCandidateState(candidate, current, nowMs);
}
