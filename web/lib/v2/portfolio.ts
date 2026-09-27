import type { AccountOrder, HistoryItem, LongPosition, Money, ShortPosition } from "./api-types";
import { displayMoney, displayQuantity, withDollar } from "../numberFormat";
import { formatShares } from "./payoffCard";
import { PRICE_TICK, premium, takerFee, type TakerFeeParams } from "./payoff";
import type { Level } from "./api-types";

const paid = (item: HistoryItem, longId: string, side: "long" | "short") => item.kind === "redemption"
  && item.longId === longId && item.data.side === side;

export type PositionOutcome = { label: string; collect: boolean; withdraw: boolean };

/**
 * What a settled position's claim pays, in words. `claimable` is the collateral-asset amount `Clearinghouse._redeem`
 * owes: USDG for a put, the underlying for a call. Only a LONG call is converted, to USDG at the market
 * when redeemed, and only when the holder has not chosen in-kind payout; the USDG it will fetch is not known until
 * then, so it is never shown as a USDG figure. A short always pays its collateral asset. Amounts follow the display
 * rules (lib/numberFormat.ts): no zero tails, at most 4 decimals of stock.
 */
function amountText(amount: Money, ticker: string): string {
  return amount.decimals === 6
    ? `${displayMoney(BigInt(amount.raw), 6)} USDG`
    : `${displayQuantity(BigInt(amount.raw), amount.decimals)} ${ticker}`;
}

function claimSentence(claim: Money, ticker: string, side: "long" | "short"): string {
  if (claim.decimals === 6) return ` Claim: ${amountText(claim, ticker)}.`;
  return side === "long"
    ? ` Claim: ${amountText(claim, ticker)}, paid as USDG unless you chose stock.`
    : ` Claim: ${amountText(claim, ticker)}, paid as stock.`;
}

/** Why a winning call can pay stock to a holder who chose USDG (Clearinghouse converts only at or above the floor). */
export const IN_KIND_CALL_NOTE =
  "Winning calls pay in stock when you chose stock, or when converting to USDG would pay less than the settlement value.";

/** A redemption event is authoritative for where a payout went; claimable describes what remains. */
export function positionOutcome(position: LongPosition | ShortPosition, side: "long" | "short",
  history: readonly HistoryItem[], now: number, walletUnits?: bigint): PositionOutcome {
  if (position.series.status === "settled" && walletUnits !== undefined && walletUnits > 0n) {
    const claim = position.claimable && BigInt(position.claimable.raw) > 0n
      ? claimSentence(position.claimable, position.series.ticker, side) : "";
    return { label: `Settled. Collect the options in your wallet.${claim}`,
      collect: true, withdraw: false };
  }
  const redemption = history.find((item) => paid(item, position.series.longId, side));
  if (redemption?.kind === "redemption") {
    const amount = redemption.data.amount;
    if (BigInt(amount.raw) === 0n)
      return { label: "Redeemed. No payout.", collect: false, withdraw: false };
    const paidText = amountText(amount, position.series.ticker);
    // A winning call paid in stock may be the settlement-floor protection, not the holder's choice.
    const why = side === "long" && amount.decimals !== 6 ? ` ${IN_KIND_CALL_NOTE}` : "";
    return redemption.data.toLedger
      ? { label: `Held in your Stonkhouse balance: ${paidText}.${why}`, collect: false, withdraw: true }
      : { label: `Paid ${paidText} to your wallet.${why}`, collect: false, withdraw: false };
  }
  if (position.series.status === "settled")
    return { label: walletUnits === undefined ? "Checking your wallet balance."
      : "Settled. None left in your wallet. Cancel any open sell orders to collect them.",
      collect: false, withdraw: false };
  if (now >= position.series.expiry || position.series.status === "settling")
    return { label: "Expired. Waiting for the final price.", collect: false, withdraw: false };
  return { label: "Position is open.", collect: false, withdraw: false };
}

/**
 * whether a held position can still be sold, listed or bought back. OrderBook refuses a new Bid or AskResale
 * at or after the series' expiry (`_place`: `limit = mintCutoff + SETTLEMENT_WINDOW`, PastCutoff when
 * `block.timestamp >= limit`), and every resting order's `validUntil` is at most that limit, so a take after it finds
 * nothing to fill. Judged on the CHAIN's clock: the page tick moved by the measured offset. Null (the clock
 * not measured yet) keeps it shut, as the order ticket and the order card do. `status` is the indexer's word: a series
 * already settling or settled is shut whatever the clock says.
 */
export function tradeWindowOpen(series: { status: string; expiry: number }, chainNowS: number | null): boolean {
  return ["open", "cutoff"].includes(series.status) && chainNowS !== null && chainNowS < series.expiry;
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
  const noun = `${shares} share${shares === "1" ? "" : "s"} of ${position.series.isPut ? "puts" : "calls"}`;
  const strike = withDollar(displayMoney(BigInt(position.series.strike.raw), position.series.strike.decimals));
  const side = position.series.isPut ? "below" : "above";
  return `Your ${noun} pay if ${position.series.ticker} ends ${side} ${strike}. You can lose at most what you paid.`;
}

export type SellQuote = { orderIds: string[]; filled: bigint; premium: bigint; fee: bigint; sellerFee: bigint;
  net: bigint; limitPrice: bigint | null; selected: { orderId: string; maker: string; price: bigint; units: bigint }[] };

/** An API order row must identify the same on-chain order before cancel or replace. */
export function orderIdentityMatches(displayed: AccountOrder, chain: { longId: bigint; kind: number }): boolean {
  const kind = displayed.kind === "Bid" ? 0 : displayed.kind === "AskResale" ? 1 : 2;
  return chain.longId === BigInt(displayed.series.longId) && chain.kind === kind;
}

/**
 * The wallet's open writer asks that the AutoRoller placed. `OrderBook.replace` lets only the delegate that
 * placed an ask through `placeFor` replace it, so the writer's own replace reverts NotAuthorized on these;
 * the writer can still cancel. The roller holds at most one live ask per writer and underlying, and the indexer keeps
 * its id on the strategy row (Rolled, then Repriced), which the positions response already carries, so no extra read.
 */
export function rollerPlacedAskIds(orders: readonly AccountOrder[],
  strategies: readonly { orderId: string | null }[]): Set<string> {
  const tracked = new Set(strategies.flatMap((row) => row.orderId === null ? [] : [row.orderId]));
  return new Set(orders.filter((order) => order.kind === "AskWrite" && tracked.has(order.orderId))
    .map((order) => order.orderId));
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

/* ------------------------------------------------------------------ neon Portfolio */

/** The hero chart's period control (the Portfolio screen): the last 7 or 30 days, or every loaded row. */
export const PNL_PERIODS = [
  { id: "1W", label: "1W", seconds: 7 * 86_400 },
  { id: "1M", label: "1M", seconds: 30 * 86_400 },
  { id: "All", label: "All", seconds: null },
] as const;
export type PnlPeriod = (typeof PNL_PERIODS)[number]["id"];

export type PnlPoint = { ts: number; cumulative: bigint };

const realisedOf = (item: HistoryItem): bigint | null =>
  "realisedPnl" in item.data && item.data.realisedPnl ? BigInt(item.data.realisedPnl.raw) : null;

/**
 * Cumulative realised P&L (USDG base units) in time order, from the same `realisedPnl` fields
 * summariseHistory totals, so the chart's last point always equals the hero figure for "All". Rows
 * before `since` fold into the opening point instead of being dropped, so a period chart starts at
 * the running total rather than at zero.
 */
export function realisedPnlSeries(items: readonly HistoryItem[], since: number | null = null): PnlPoint[] {
  const rows = items.flatMap((item) => {
    const value = realisedOf(item);
    return value === null ? [] : [{ ts: item.ts, value }];
  }).sort((a, b) => a.ts - b.ts);
  let running = 0n;
  const points: PnlPoint[] = [];
  for (const row of rows) {
    running += row.value;
    if (since !== null && row.ts < since) continue;
    if (!points.length && since !== null) points.push({ ts: since, cumulative: running - row.value });
    points.push({ ts: row.ts, cumulative: running });
  }
  if (!points.length && since !== null) points.push({ ts: since, cumulative: running });
  return points;
}

/** Realised P&L booked at or after `since` (USDG base units). */
export function realisedPnlSince(items: readonly HistoryItem[], since: number): bigint {
  return items.reduce((sum, item) => {
    const value = realisedOf(item);
    return value !== null && item.ts >= since ? sum + value : sum;
  }, 0n);
}

/**
 * SVG polyline points for the hero chart. X is time, Y is cumulative P&L; a flat series sits on the
 * baseline. Fewer than two points draws nothing, because one point is not a line.
 */
export function pnlPolyline(points: readonly PnlPoint[], width: number, height: number, pad = 8): string {
  if (points.length < 2) return "";
  const t0 = points[0]!.ts;
  const t1 = points[points.length - 1]!.ts;
  const values = points.map((point) => point.cumulative);
  const lo = values.reduce((a, b) => (b < a ? b : a));
  const hi = values.reduce((a, b) => (b > a ? b : a));
  const span = Number(hi - lo);
  const x = (ts: number) => (t1 === t0 ? 0 : ((ts - t0) / (t1 - t0)) * width);
  const y = (value: bigint) => span === 0 ? height - pad : height - pad - (Number(value - lo) / span) * (height - 2 * pad);
  return points.map((point) => `${x(point.ts).toFixed(1)},${y(point.cumulative).toFixed(1)}`).join(" ");
}

export type PositionRow = {
  paid: string;
  now: string | null;
  nowLabel: "Bid now" | "Fair now";
  /** Change from paid to now in basis points, or null without a mark or with a zero cost. */
  changeBps: number | null;
  action: "Collect" | "Sell";
};

/**
 * The compact row for one long (spec s8: paid, bid now, %, Sell or Collect). "Bid now" is only claimed
 * when the mark IS the best bid; a fair-value mark is labelled as such. A claimable balance on a settled
 * series turns the action into Collect.
 */
export function longPositionRow(position: LongPosition): PositionRow {
  const cost = BigInt(position.avgCost.raw);
  const mark = position.mark ? BigInt(position.mark.raw) : null;
  const claimable = position.claimable ? BigInt(position.claimable.raw) : 0n;
  return {
    paid: position.avgCost.formatted,
    now: position.mark?.formatted ?? null,
    nowLabel: position.markSource === "fair" ? "Fair now" : "Bid now",
    changeBps: mark === null || cost === 0n ? null : Number(((mark - cost) * 10_000n) / cost),
    action: position.series.status === "settled" && claimable > 0n ? "Collect" : "Sell",
  };
}

/** "+12.5%" / "−3.0%" from basis points, one decimal, with a real minus sign. */
export function formatChangeBps(bps: number): string {
  const pct = (Math.abs(bps) / 100).toFixed(1);
  return bps > 0 ? `+${pct}%` : bps < 0 ? `−${pct}%` : "0.0%";
}

/**
 * The rail's "Ready to collect" figure: claimable USDG on settled longs. Claims in another asset are counted,
 * never added to the USDG total: a long call's claim is owed in the underlying, and even a holder on the default
 * USDG preference only learns the USDG amount when redeem converts it at the market.
 */
export function readyToCollect(longs: readonly LongPosition[]): { usdgRaw: bigint; positions: number; otherAssets: number } {
  let usdgRaw = 0n;
  let positions = 0;
  let otherAssets = 0;
  for (const long of longs) {
    if (long.series.status !== "settled" || !long.claimable || BigInt(long.claimable.raw) <= 0n) continue;
    positions += 1;
    if (long.claimable.decimals === 6) usdgRaw += BigInt(long.claimable.raw);
    else otherAssets += 1;
  }
  return { usdgRaw, positions, otherAssets };
}
