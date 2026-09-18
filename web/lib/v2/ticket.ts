import { writerCollateralNeed, type RentTerms } from "./rent";
import type { Level } from "./api-types";
import { BPS, PRICE_TICK, costToBuy, premium, type BuyCost, type TakerFeeParams } from "./payoff";
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

/** A smaller size or partial-fill choice helps only when some depth is actually fillable. */
export function partialDepthMessage(filledUnits: bigint, requestedUnits: bigint): string | null {
  if (filledUnits <= 0n || requestedUnits <= 0n || filledUnits >= requestedUnits) return null;
  return `Only ${formatShareQuantity(filledUnits)} available for your ${formatShareQuantity(requestedUnits)} order. Choose a smaller size or enable partial fill.`;
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
      (row.kind === 2 && (row.freeCollateral === null || collateralPerUnit <= 0n))) {
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
