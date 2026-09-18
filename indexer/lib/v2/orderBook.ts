/** Event reductions for the v2 OrderBook. No database or RPC dependency. */

export type OrderKind = "Bid" | "AskResale" | "AskWrite";
export type OrderStatus = "open" | "filled" | "cancelled" | "pruned" | "expired";

export type OrderView = {
  units: bigint;
  filled: bigint;
  status: OrderStatus;
};

export function orderKind(value: number): OrderKind {
  switch (value) {
    case 0: return "Bid";
    case 1: return "AskResale";
    case 2: return "AskWrite";
    default: throw new Error(`Unknown OrderKind ${value}`);
  }
}

/** The contract's zero sentinel means the mint cutoff for a writing ask, expiry otherwise. */
export function orderValidUntil(kind: OrderKind, specified: bigint, mintCutoff: bigint, expiry: bigint): bigint {
  if (specified < 0n || mintCutoff < 0n || expiry < 0n) throw new Error("Negative order time");
  const deadline = kind === "AskWrite" ? mintCutoff : expiry;
  return specified === 0n ? deadline : specified < deadline ? specified : deadline;
}

export function placeOrder(units: bigint): OrderView {
  if (units <= 0n) throw new Error("Order units must be positive");
  return { units, filled: 0n, status: "open" };
}

export function fillOrder(order: OrderView, units: bigint): OrderView {
  if (order.status !== "open") throw new Error(`Cannot fill ${order.status} order`);
  if (units <= 0n || order.filled + units > order.units) throw new Error("Order fill outside remaining units");
  const filled = order.filled + units;
  return { ...order, filled, status: filled === order.units ? "filled" : "open" };
}

export function cancelOrder(order: OrderView, remaining: bigint, pruned: boolean): OrderView {
  // A synthetic clock sweep may already have marked it expired before an on-chain prune.
  if (order.status !== "open" && order.status !== "expired") throw new Error(`Cannot cancel ${order.status} order`);
  if (remaining !== order.units - order.filled) throw new Error("Order cancellation remaining units mismatch");
  return { ...order, status: pruned ? "pruned" : "cancelled" };
}

export function expireOrder(order: OrderView, validUntil: bigint, now: bigint): OrderView {
  return order.status === "open" && now >= validUntil ? { ...order, status: "expired" } : order;
}

export type ReplacementCandidate = {
  orderId: bigint;
  maker: string;
  longId: bigint;
  cancelledTx: string | null;
  cancelledLogIndex: number | null;
  replacedBy: bigint | null;
  status: OrderStatus;
};

/** Nearest preceding, unused cancellation in the same transaction is the replace() predecessor. */
export function replacementPredecessor(
  candidates: readonly ReplacementCandidate[],
  placed: { maker: string; longId: bigint; tx: string; logIndex: number },
): bigint | null {
  let match: ReplacementCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.status !== "cancelled" || candidate.replacedBy !== null || candidate.cancelledLogIndex === null) continue;
    if (candidate.cancelledTx?.toLowerCase() !== placed.tx.toLowerCase()) continue;
    if (candidate.maker.toLowerCase() !== placed.maker.toLowerCase() || candidate.longId !== placed.longId) continue;
    if (candidate.cancelledLogIndex >= placed.logIndex) continue;
    if (match === null || candidate.cancelledLogIndex > match.cancelledLogIndex!) match = candidate;
  }
  return match?.orderId ?? null;
}

/** For an ask the taker may send purchased longs to another recipient (interface v4).
 * For a bid, recipient is the USDG payout address and the bid maker owns the long. */
export function fillParties<T extends string>(maker: T, taker: T, recipient: T, takerIsBuyer: boolean): { buyer: T; seller: T } {
  return takerIsBuyer ? { buyer: recipient, seller: maker } : { buyer: maker, seller: taker };
}

export function withDelegate(current: string, delegate: string, approved: boolean): string {
  const value = JSON.parse(current) as Record<string, boolean>;
  const key = delegate.toLowerCase();
  if (approved) value[key] = true;
  else delete value[key];
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}
