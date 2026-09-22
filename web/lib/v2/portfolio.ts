import type { AccountOrder, HistoryItem, LongPosition, ShortPosition } from "./api-types";
import { formatShares } from "./payoffCard";
import { PRICE_TICK, premium, takerFee, type TakerFeeParams } from "./payoff";
import type { Level } from "./api-types";

const paid = (item: HistoryItem, longId: string, side: "long" | "short") => item.kind === "redemption"
  && item.longId === longId && item.data.side === side;

export type PositionOutcome = { label: string; collect: boolean; withdraw: boolean };

/** A redemption event is authoritative for where a payout went; claimable describes what remains. */
export function positionOutcome(position: LongPosition | ShortPosition, side: "long" | "short",
  history: readonly HistoryItem[], now: number, walletUnits?: bigint): PositionOutcome {
  if (position.series.status === "settled" && walletUnits !== undefined && walletUnits > 0n) {
    const estimate = position.claimable && BigInt(position.claimable.raw) > 0n
      ? ` Estimated in-kind claim: ${position.claimable.formatted}.` : "";
    return { label: `Settlement is complete. Collect the units in your wallet.${estimate}`,
      collect: true, withdraw: false };
  }
  const redemption = history.find((item) => paid(item, position.series.longId, side));
  if (redemption?.kind === "redemption") {
    const amount = redemption.data.amount;
    if (BigInt(amount.raw) === 0n)
      return { label: "Redeemed. This position had no payout at settlement.", collect: false, withdraw: false };
    const symbol = amount.decimals === 6 ? "USDG" : position.series.ticker;
    return redemption.data.toLedger
      ? { label: `Held in your Stonkhouse balance: ${amount.formatted} ${symbol}.`, collect: false, withdraw: true }
      : { label: `Paid ${amount.formatted} ${symbol} to your wallet.`, collect: false, withdraw: false };
  }
  if (position.series.status === "settled")
    return { label: walletUnits === undefined ? "Checking your on-chain balance before collection."
      : "Settlement is complete. No wallet units remain to collect; cancel any escrowed resale orders before redeeming.",
      collect: false, withdraw: false };
  if (now >= position.series.expiry || position.series.status === "settling")
    return { label: "Expiry passed. Settlement is being finalized.", collect: false, withdraw: false };
  return { label: "Position is open.", collect: false, withdraw: false };
}

export function expiryCountdown(expiry: number, now: number): string {
  const remaining = expiry - now;
  if (remaining <= 0) return "Expired";
  if (remaining >= 86_400) return `${Math.ceil(remaining / 86_400)} days left`;
  if (remaining >= 3_600) { const hours = Math.ceil(remaining / 3_600); return `${hours} hour${hours === 1 ? "" : "s"} left`; }
  const minutes = Math.ceil(remaining / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} left`;
}

export function payoffSentence(position: LongPosition): string {
  const shares = formatShares(BigInt(position.units));
  const strike = position.series.strike.formatted;
  return position.series.isPut
    ? `Your ${shares} share${shares === "1" ? "" : "s"} of puts can pay when ${position.series.ticker} finishes below $${strike}. Max loss is your entry cost.`
    : `Your ${shares} share${shares === "1" ? "" : "s"} of calls can pay when ${position.series.ticker} finishes above $${strike}. Max loss is your entry cost.`;
}

export type SellQuote = { orderIds: string[]; filled: bigint; premium: bigint; fee: bigint; sellerFee: bigint;
  net: bigint; limitPrice: bigint | null; selected: { orderId: string; maker: string; price: bigint; units: bigint }[] };

/** An API order row must identify the same on-chain order before cancel or replace. */
export function orderIdentityMatches(displayed: AccountOrder, chain: { longId: bigint; kind: number }): boolean {
  const kind = displayed.kind === "Bid" ? 0 : displayed.kind === "AskResale" ? 1 : 2;
  return chain.longId === BigInt(displayed.series.longId) && chain.kind === kind;
}

/** Walk highest bids first. The on-chain quote is checked again just before submission. */
export function quoteSell(levels: readonly Level[], requested: bigint, fees: TakerFeeParams,
  resaleFeeBps = 0, account?: string): SellQuote {
  if (requested <= 0n) throw new RangeError("Sell size must be positive.");
  const bids = levels.flatMap((level) => level.orders.filter((order) => order.kind === "Bid" &&
    order.maker.toLowerCase() !== account?.toLowerCase())
    .map((order) => ({ orderId: order.orderId, maker: order.maker, price: BigInt(level.price.raw), units: BigInt(order.units) })))
    .sort((a, b) => a.price > b.price ? -1 : a.price < b.price ? 1 : BigInt(a.orderId) < BigInt(b.orderId) ? -1 : 1);
  const selected: SellQuote["selected"] = [];
  let filled = 0n;
  let total = 0n;
  let sellerFee = 0n;
  for (const bid of bids) {
    if (filled === requested) break;
    if (bid.price <= 0n || bid.price % PRICE_TICK !== 0n || bid.units <= 0n) continue;
    const units = bid.units < requested - filled ? bid.units : requested - filled;
    const leg = premium(bid.price, units);
    total += leg;
    sellerFee += leg * BigInt(resaleFeeBps) / 10_000n;
    filled += units;
    selected.push({ ...bid, units });
  }
  const fee = takerFee(total, fees);
  const minimum = selected.length ? selected[selected.length - 1]!.price : null;
  return { orderIds: selected.map((bid) => bid.orderId), filled, premium: total, fee, sellerFee,
    net: total - fee - sellerFee,
    limitPrice: minimum, selected };
}

/** An ask crossing bids sells immediately first; only unsold units may rest in the book. */
export function splitResale(levels: readonly Level[], units: bigint, askPrice: bigint,
  fees: TakerFeeParams, resaleFeeBps: number, account: string) {
  const crossing = quoteSell(levels.filter((level) => BigInt(level.price.raw) >= askPrice),
    units, fees, resaleFeeBps, account);
  return { crossing, restingUnits: units - crossing.filled };
}

export function verifySellOrders(quote: SellQuote, orders: readonly { orderId: bigint; maker: string;
  longId: bigint; kind: number; price: bigint; units: bigint; filled: bigint; validUntil: number; cancelled: boolean }[],
  longId: bigint, now: number): boolean {
  const current = new Map(orders.map((order) => [order.orderId.toString(), order]));
  return quote.selected.every((selected) => {
    const order = current.get(selected.orderId);
    return order !== undefined && order.kind === 0 && order.longId === longId && !order.cancelled &&
      order.validUntil > now && order.price === selected.price && order.maker.toLowerCase() === selected.maker.toLowerCase() &&
      order.units - order.filled >= selected.units;
  });
}
