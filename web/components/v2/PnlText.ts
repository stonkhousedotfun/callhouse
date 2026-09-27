import { displayQuantity } from "@/lib/numberFormat";
import type { Card, Money, PnlResponse, SeriesRef } from "@/lib/v2/api-types";
import { group } from "@/lib/v2/payoffFormat";

function decimal(raw: string, decimals: number, places: number, direction: "up" | "down"): string {
  const unit = 10n ** BigInt(decimals);
  const scale = 10n ** BigInt(places);
  const value = BigInt(raw) * scale;
  const rounded = direction === "up" ? (value + unit - 1n) / unit : value / unit;
  const whole = rounded / scale;
  const fraction = String(rounded % scale).padStart(places, "0");
  return places === 0 ? String(whole) : `${whole}.${fraction}`;
}

export function receiptMoney(money: Money): string {
  const [whole, fraction = ""] = money.formatted.split(".");
  return fraction.replace(/0+$/, "") ? `${whole}.${fraction.replace(/0+$/, "")}` : whole ?? "0";
}

export function sharesFromUnits(units: string): string {
  const value = BigInt(units);
  const whole = value / 100n;
  const fraction = String(value % 100n).padStart(2, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** To the cent, rounded the stated way (cost up, value down), with no ".00" tail: "1.03", "5", "1,234.50". */
export function imageMoney(money: Money, direction: "up" | "down"): string {
  const [whole = "0", cents = "00"] = decimal(money.raw, money.decimals, 2, direction).split(".");
  return cents === "00" ? group(BigInt(whole)) : `${group(BigInt(whole))}.${cents}`;
}

/** A multiple to at most two decimals, no zero tail: "4.29×", "1.1×", "8×". A 1.04× win never reads 1×. */
export function multipleText(multiple: number): string {
  if (!Number.isFinite(multiple)) return "—";
  return `${displayQuantity(BigInt(Math.round(multiple * 100)), 2)}×`;
}

export function seriesTitle(series: SeriesRef): string {
  const strike = receiptMoney(series.strike);
  return `${series.ticker} $${strike} ${series.isPut ? "put" : "call"}`;
}

export function expiryLabel(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "numeric", month: "short", year: "numeric" })
    .format(new Date(timestamp * 1000));
}

export function receiptImageCopy(pnl: PnlResponse) {
  return {
    headline: `${imageMoney(pnl.cost, "up")} → ${imageMoney(pnl.payout, "down")} USDG value`,
    multiple: multipleText(pnl.multiple),
    series: seriesTitle(pnl.series),
    expiry: expiryLabel(pnl.series.expiry),
    maxLoss: `Max loss was ${imageMoney(pnl.cost, "up")} USDG`,
  };
}

/**
 * (a multiple always carries its scenario). The root OG image's live-option lines.
 * The card's multiple is payout at `card.target` ÷ cost, so the scenario that makes it true is the headline printed
 * directly under it, and the max loss is the risk line. A put "falls to" its target and a call "reaches" it; at most
 * two decimals like every other multiple in the app (the image used to print the raw float).
 */
export function liveOptionImageLines(card: Card) {
  const ticket = card.perShare ?? card.perUnit;
  return {
    eyebrow: "Live option",
    metric: multipleText(ticket.multiple),
    headline: `If ${card.series.ticker} ${card.series.isPut ? "falls to" : "reaches"} $${receiptMoney(card.target)} by expiry`,
    detail: `${seriesTitle(card.series)} · payout at that price ÷ cost, after fees`,
    risk: `Max loss is ${imageMoney(ticket.cost, "up")} USDG for this ticket`,
  };
}

export function pnlShareText(pnl: PnlResponse): string {
  const copy = receiptImageCopy(pnl);
  const payoutNote = pnl.settlementPrice === null ? "Closed by resale before settlement." :
    "In-kind Stock Tokens are valued at settlement price.";
  return `${copy.series}: ${copy.headline} (${copy.multiple}). ${copy.maxLoss}. ${payoutNote} Verified on Robinhood Chain.`;
}

export function tokenMetadataText(series: SeriesRef, isShort: boolean) {
  const side = isShort ? "short" : "long";
  const title = `${seriesTitle(series)} · ${expiryLabel(series.expiry)} · ${side}`;
  const outcome = series.isPut ? "below" : "above";
  const rule = isShort
    ? `This short position writes a ${series.isPut ? "put" : "call"}. Its payoff depends on the settlement price and any premium earned from a fill.`
    : `This long position pays if the settlement price is ${outcome} the $${receiptMoney(series.strike)} strike at expiry. Maximum loss is the amount paid to acquire it.`;
  return { title, description: `${rule} One token unit represents 0.01 share.` };
}
