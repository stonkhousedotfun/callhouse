import { writerCollateralNeed, type RentTerms } from "./rent";
import type { Level } from "./api-types";
import { BPS, PRICE_TICK, UNITS_PER_SHARE, breakeven, costToBuy, payoutAt, premium, takerFee, type BuyCost, type TakerFeeParams } from "./payoff";
import { formatShareQuantity } from "./payoffCard";

export type TicketAsk = { orderId: string; maker: string; kind: "AskResale" | "AskWrite"; price: bigint;
  units: bigint; onChainRemainingUnits: bigint; makerFreeUnits: bigint | null; makerFreeCollateral: bigint | null };
export type BuyQuote = { buy: BuyCost; limitPrice: bigint | null; asks: TicketAsk[] };

export function flattenAsks(levels: readonly Level[], taker?: string): TicketAsk[] {
  return levels.flatMap((level) => level.orders.filter((order) => order.kind !== "Bid" &&
    order.maker.toLowerCase() !== taker?.toLowerCase())
    .map((order) => ({ orderId: order.orderId, maker: order.maker, kind: order.kind as TicketAsk["kind"],
      price: BigInt(level.price.raw), units: BigInt(order.units),
      onChainRemainingUnits: BigInt(order.onChainRemainingUnits),
      makerFreeCollateral: order.makerFreeCollateral ? BigInt(order.makerFreeCollateral.raw) : null,
      makerFreeUnits: order.makerFreeUnits === null ? null : BigInt(order.makerFreeUnits) })));
}

function ceilDiv(a: bigint, b: bigint): bigint { return (a + b - 1n) / b; }

/** Limit is the worst selected ask plus tolerance, rounded up to the contract tick. */
export function buyQuote(levels: readonly Level[], units: bigint, fees: TakerFeeParams, toleranceBps = 200,
  taker?: string, rent?: RentTerms): BuyQuote {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 1_000) throw new RangeError("slippage tolerance must be 0–10%");
  const asks = flattenAsks(levels, taker);
  const buy = costToBuy(asks, units, fees, rent);
  const worst = buy.fills.reduce((max, fill) => fill.price > max ? fill.price : max, 0n);
  const limitPrice = worst > 0n ? ceilDiv(worst * (BPS + BigInt(toleranceBps)), BPS * PRICE_TICK) * PRICE_TICK : null;
  return { buy, limitPrice, asks };
}

/** An unusable API book must disable the quote, not crash the ticket or Portfolio. */
export function safeBuyQuote(...args: Parameters<typeof buyQuote>): BuyQuote | null {
  try { return buyQuote(...args); } catch { return null; }
}

/**
 * A smaller size or partial-fill choice helps only when some depth is actually fillable.
 *
 * `unpriceableAsks` is the count of listed asks the walk skipped because it could not price them
 * (BuyCost.unpriceableAsks: no maker, rent terms or collateral read). Those asks exist, so the message must not read as
 * if the book simply ran out: it states the size available at a price, then says separately that the rest has no price.
 */
export function partialDepthMessage(filledUnits: bigint, requestedUnits: bigint, unpriceableAsks = 0): string | null {
  if (filledUnits <= 0n || requestedUnits <= 0n || filledUnits >= requestedUnits) return null;
  const size = `${formatShareQuantity(filledUnits)} available`;
  const order = `for your ${formatShareQuantity(requestedUnits)} order`;
  const next = "Choose a smaller size or enable partial fill.";
  if (unpriceableAsks <= 0) return `Only ${size} ${order}. ${next}`;
  const asks = unpriceableAsks === 1 ? "1 more listed ask has" : `${unpriceableAsks} more listed asks have`;
  return `Only ${size} at a price ${order}. ${asks} no price right now. ${next}`;
}

export function bidSplit(levels: readonly Level[], units: bigint, bidPrice: bigint, fees: TakerFeeParams,
  taker?: string, rent?: RentTerms) {
  if (bidPrice <= 0n || bidPrice % PRICE_TICK !== 0n) throw new RangeError("Bid price must be on the price tick");
  const crossingLevels = levels.filter((level) => BigInt(level.price.raw) <= bidPrice);
  const crossing = buyQuote(crossingLevels, units, fees, 0, taker, rent);
  const restingUnits = units - crossing.buy.filledUnits;
  return { crossing, restingUnits, escrow: restingUnits > 0n ? premium(bidPrice, restingUnits) : 0n };
}

/** A confirmed crossing buy remains final even if the separate remainder bid fails. */
export async function completeBidAfterCrossing(requested: bigint, filled: bigint,
  placeRemainder: (units: bigint) => Promise<void>): Promise<
    { kind: "complete"; restingUnits: bigint } | { kind: "partial"; restingUnits: bigint; error: unknown }> {
  if (filled < 0n || filled > requested) throw new RangeError("Invalid crossing fill size");
  const restingUnits = requested - filled;
  if (restingUnits === 0n) return { kind: "complete", restingUnits };
  try {
    await placeRemainder(restingUnits);
    return { kind: "complete", restingUnits };
  } catch (error) {
    if (filled === 0n) throw error;
    return { kind: "partial", restingUnits, error };
  }
}

export function crossingBidUnknownMessage(filled: bigint, operation: string): string {
  const bought = filled > 0n ? `Bought ${formatShareQuantity(filled)} now. ` : "";
  const bid = filled > 0n ? "remaining bid" : "bid";
  const status = operation === "approve"
    ? `The USDG approval for the ${bid} was submitted, but its status is unknown. The bid was not placed. `
    : `The ${bid} transaction was submitted, but its status is unknown. The bid may not have been placed. `;
  return `${bought}${status}Check Portfolio and the explorer before taking another action.`;
}

export type ChainOrder = {
  orderId: bigint;
  maker: string;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
  freeCollateral: bigint | null;
  /**
   * `Clearinghouse.isOperator(maker, book)` for a write ask, read with the order. Without it the take skips
   * the ask (OrderBook `_consume`: `usable` false consumes nothing). Undefined: not read. chainReads.ts readOrderPreflight
   * does not read it yet (rows hold that file), so until it does this check cannot fire.
   */
  writerIsOperator?: boolean | null;
};

/** Reject a changed order rather than silently filling a different quote after reread. */
export function staleSelectedOrders(quote: BuyQuote, selected: readonly ChainOrder[], longId: bigint, collateralPerUnit: bigint, now: number, rent?: RentTerms): string[] {
  const byId = new Map(selected.map((row) => [row.orderId.toString(), row]));
  const expected = new Map(quote.asks.map((ask) => [ask.orderId, ask]));
  const writerBudget = new Map<string, bigint>();
  return quote.buy.fills.flatMap((fill) => {
    const row = byId.get(fill.orderId);
    const ask = expected.get(fill.orderId);
    if (!row || !ask || row.cancelled || row.validUntil <= now || row.longId !== longId ||
      row.kind !== (ask.kind === "AskResale" ? 1 : 2) || row.price !== fill.price ||
      row.maker.toLowerCase() !== ask.maker.toLowerCase() ||
      row.units - row.filled !== ask.onChainRemainingUnits || row.units - row.filled < fill.units ||
      (row.kind === 2 && (row.freeCollateral === null || collateralPerUnit <= 0n || row.writerIsOperator === false))) {
      return [fill.orderId];
    }
    if (row.kind === 2) {
      if (!rent) return [fill.orderId];
      const maker = row.maker.toLowerCase();
      const available = writerBudget.get(maker) ?? row.freeCollateral!;
      if ((rent.snapshotTimestamp >= rent.expiry || (rent.mintCutoff !== undefined && rent.snapshotTimestamp >= rent.mintCutoff))) return [fill.orderId];
      const need = writerCollateralNeed(fill.units, rent);
      if (available < need) return [fill.orderId];
      writerBudget.set(maker, available - need);
    }
    return [];
  });
}

// ---------------------------------------------------------------------------------------------
// Market page rows and the rail summary (Neon design).
// ---------------------------------------------------------------------------------------------

/** The scenario every market-page multiple carries: +10% for a call, -10% for a put. */
export const SCENARIO_MOVE_BPS = 1_000;

/** "If +10%" / "If −10%". A multiple is never shown without its scenario. */
export function scenarioLabel(isPut: boolean): string {
  return isPut ? "If −10%" : "If +10%";
}

export type StrikeRowInput = {
  series: { longId: string; isPut: boolean; strike: { raw: string; formatted: string }; expiry: number };
  /** `askUnits` is TOTAL depth; `bestAskUnits` the units at `bestAsk` (absent from an API before it). */
  quote: { bestAsk: { raw: string } | null; askUnits: string; bestAskUnits?: string };
};

export type StrikeRow = {
  longId: string;
  isPut: boolean;
  /** USDG-6 per share. */
  strike: bigint;
  expiry: number;
  /** "$236 call". */
  label: string;
  /** Best ask per share, USDG-6; null with no ask. */
  ask: bigint | null;
  /** Units resting at the best ask; the total depth only from an API that does not state it (`bestAskUnits` null). */
  askUnits: bigint;
  /** Units at the best ask as the API states them; null from an older API, which then prices nothing. */
  bestAskUnits: bigint | null;
  /** One share at the best ask plus its taker fee, USDG-6; null with no ask or not a whole share at the best ask. */
  costPerShare: bigint | null;
  breakEven: bigint | null;
  /** Payout at the scenario price divided by `costPerShare`, floored to 1 dp; before the exercise fee. */
  scenarioMultiple: number | null;
};

/**
 * One strike row, from the market series wire item and the live fee parameters. Everything is per ONE SHARE at the
 * best ask, which is what the row claims ("Fees included · per share"): premium(ask, 100 units) plus the capped taker
 * fee on that premium (spec 6.3, `costFromQuote`). A row with less than one share at the best ask shows no cost
 * rather than a per-share figure the book cannot fill; the ticket walks deeper levels.
 *
 * The scenario multiple is BEFORE the exercise fee: the market series wire does not carry the series-pinned fee, and
 * the page says so beside the column instead of assuming the current rate.
 */
export function strikeRow(item: StrikeRowInput, fees: TakerFeeParams | null, spot: bigint | null): StrikeRow {
  const { series, quote } = item;
  const strike = BigInt(series.strike.raw);
  const ask = quote.bestAsk ? BigInt(quote.bestAsk.raw) : null;
  // One price per share holds only for the units AT the best ask. `askUnits` is every level, so 40 units at
  // 0.50 over 100 at 0.80 priced a share at 0.55 (0.50 + fee) that the book fills at 0.748. Without the best-level
  // figure there is no per-share cost, never one read off the total.
  const bestAskUnits = quote.bestAskUnits === undefined ? null : BigInt(quote.bestAskUnits);
  const askUnits = bestAskUnits ?? BigInt(quote.askUnits);
  const oneShare = UNITS_PER_SHARE;
  const costPerShare = ask !== null && ask > 0n && fees && bestAskUnits !== null && bestAskUnits >= oneShare
    ? costFromPremium(premium(ask, oneShare), fees) : null;
  const position = { isPut: series.isPut, strike, units: oneShare, exerciseFeeBps: 0 };
  const breakEven = costPerShare !== null ? breakeven(position, costPerShare) : null;
  let scenarioMultiple: number | null = null;
  if (costPerShare !== null && costPerShare > 0n && spot !== null && spot > 0n) {
    const move = BigInt(SCENARIO_MOVE_BPS);
    const target = series.isPut ? (spot * (BPS - move)) / BPS : (spot * (BPS + move)) / BPS;
    const tenths = (payoutAt(target, position) * 10n) / costPerShare;
    scenarioMultiple = Number(tenths) / 10;
  }
  return {
    longId: series.longId, isPut: series.isPut, strike, expiry: series.expiry,
    label: `$${series.strike.formatted} ${series.isPut ? "put" : "call"}`,
    ask, askUnits, bestAskUnits, costPerShare, breakEven, scenarioMultiple,
  };
}

function costFromPremium(premiumPaid: bigint, fees: TakerFeeParams): bigint {
  return premiumPaid + takerFee(premiumPaid, fees);
}

/** "12.3×", or an em dash. */
export function formatMultipleTenths(multiple: number | null): string {
  return multiple === null ? "—" : `${multiple.toFixed(1)}×`;
}

export type RailSummary = {
  units: bigint;
  /** Premium for `units` at the best ask, USDG-6. */
  premium: bigint;
  /** The capped taker fee on that premium. */
  fee: bigint;
  /** premium + fee: the max loss. */
  cost: bigint;
  breakEven: bigint | null;
  /** True when `units` is more than rests at the best ask: the figures are a best-ask estimate, the ticket walks the book. */
  beyondBestAsk: boolean;
};

/**
 * The rail's figures for `units` of a row: premium, capped fee, break-even and max loss, at
 * the BEST ASK. The rail is a summary; the order ticket on the series page walks every level and is the binding quote.
 * Null with no ask or no fee parameters, so the rail shows its empty state rather than a zero.
 */
export function railSummary(row: StrikeRow, units: bigint, fees: TakerFeeParams | null): RailSummary | null {
  if (row.ask === null || row.ask <= 0n || !fees || units <= 0n) return null;
  const paid = premium(row.ask, units);
  const fee = takerFee(paid, fees);
  const cost = paid + fee;
  const position = { isPut: row.isPut, strike: row.strike, units, exerciseFeeBps: 0 };
  // Unknown best-level depth counts as beyond it: the figures are then an estimate, never a promise.
  const beyondBestAsk = row.bestAskUnits === null || units > row.bestAskUnits;
  return { units, premium: paid, fee, cost, breakEven: breakeven(position, cost), beyondBestAsk };
}

/** P&L at expiry for a summary at `price` (USDG-6 per share), before the exercise fee: payout minus cost. */
export function railPnlAt(row: StrikeRow, summary: RailSummary, price: bigint): bigint {
  return payoutAt(price, { isPut: row.isPut, strike: row.strike, units: summary.units, exerciseFeeBps: 0 }) - summary.cost;
}

/** Share-size stepper: whole shares from 1 to `max`, clamped. */
export function stepShares(current: number, delta: number, max = 1_000): number {
  const next = Math.round(current + delta);
  return Math.min(Math.max(next, 1), max);
}

/**
 * The ticket's share stepper: whole-share steps on the shares input. A fractional or unreadable entry
 * steps from its whole part, and the result never drops below one share.
 */
export function stepShareInput(input: string, delta: number): string {
  const current = Number(input);
  const whole = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  return String(Math.max(1, whole + delta));
}
