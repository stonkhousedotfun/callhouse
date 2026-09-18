import type { Card } from "./api-types";
import { cardSentence, premium, takerFee, type TakerFeeParams } from "./payoff";

const USDG_SCALE = 1_000_000n;
const QUOTE_MAX_AGE_SECONDS = 60;

export type CardState = "live" | "thin" | "stale" | "cutoff";

export type PayoffCardView = {
  state: CardState;
  units: bigint;
  availableShares: string;
  quotedAcrossLevels: boolean;
  cost: bigint | null;
  payout: bigint;
  profitAtTarget: bigint | null;
  multiple: number | null;
  sentence: string;
  buyHref: string;
};

export function formatShares(units: bigint): string {
  const whole = units / 100n;
  const fraction = (units % 100n).toString().padStart(2, "0");
  return fraction === "00" ? whole.toString() : `${whole}.${fraction}`.replace(/0$/, "");
}

/** A contract unit is 0.01 share; only 100 units is grammatically singular. */
export function formatShareQuantity(units: bigint): string {
  return `${formatShares(units)} share${units === 100n ? "" : "s"}`;
}

/** Keep all base-unit precision on tiny option premiums; round only in cardSentence. */
export function formatUsdg(raw: bigint): string {
  const sign = raw < 0n ? "−" : "";
  const amount = raw < 0n ? -raw : raw;
  const whole = (amount / USDG_SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (amount % USDG_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function payoffCardView(card: Card, units: bigint, feeParams: TakerFeeParams | null, now: number | null, quoteAsOf: number | null): PayoffCardView {
  if (units <= 0n) throw new RangeError("card size must be positive");
  const available = BigInt(card.unitsAvailable);
  const wholeShare = units === 100n ? card.perShare : null;
  const payout = wholeShare ? BigInt(wholeShare.payoutAtTarget.raw) : BigInt(card.perUnit.payoutAtTarget.raw) * units;
  // The API's one-unit cost is authoritative. For larger sizes, the flat fee is
  // applied once to the whole take, rather than multiplied by the unit count.
  const quotedPremium = units > 1n && feeParams && units <= available ? premium(BigInt(card.ask.raw), units) : null;
  const cost = wholeShare ? BigInt(wholeShare.cost.raw) : units === 1n ? BigInt(card.perUnit.cost.raw)
    : quotedPremium !== null && feeParams ? quotedPremium + takerFee(quotedPremium, feeParams) : null;
  const multiple = cost && cost > 0n ? Number((payout * 100n) / cost) / 100 : null;
  const stale = now === null || quoteAsOf === null || now - quoteAsOf > QUOTE_MAX_AGE_SECONDS || quoteAsOf > now + 5;
  // Mint cutoff ends new write-on-fill asks, but resale asks remain tradable until expiry.
  // The cards API only publishes a card when a live ask remains behind it.
  const cutoff = now !== null && (now >= card.series.expiry || !["open", "cutoff"].includes(card.series.status));
  const state: CardState = cutoff ? "cutoff" : stale ? "stale" : available < units && !wholeShare ? "thin" : "live";
  const shares = formatShares(units);
  return {
    state, units, availableShares: formatShares(available), quotedAcrossLevels: Boolean(wholeShare && available < units), cost, payout,
    profitAtTarget: cost === null ? null : payout - cost,
    multiple,
    sentence: cost === null ? cardSentence(card, 1n) : cardSentence(card, units, { cost, payout }),
    buyHref: `/${card.series.ticker.toLowerCase()}/${card.series.longId}?buy=1&shares=${encodeURIComponent(shares)}`,
  };
}
