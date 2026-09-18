import type { Money, PnlResponse, SeriesRef } from "@/lib/v2/api-types";

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

export function imageMoney(money: Money, direction: "up" | "down"): string {
  return decimal(money.raw, money.decimals, 2, direction);
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
    multiple: `${pnl.multiple.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×`,
    series: seriesTitle(pnl.series),
    expiry: expiryLabel(pnl.series.expiry),
    maxLoss: `Max loss was ${imageMoney(pnl.cost, "up")} USDG`,
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
  return { title, description: `${rule} One token unit represents 0.01 share. Settlement follows the StonkHouse v2 contracts on Robinhood Chain.` };
}
