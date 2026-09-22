import {
  BPS, MAX_PAYOUT_SLIPPAGE_CEIL_BPS, collateralPerUnit, exerciseFeePerUnit, grossPayoutPerUnit, pnlAt, usdgPayoutBand,
  type BuyCost, type ConversionTerms, type PayoffPosition, type Pnl, type TakerFeeParams, type UsdgBand,
} from "./payoff";
import { formatShares } from "./payoffCard";

/** The receipt of one scenario (design §2.5): every cash flow of a buy and of its settlement, one line per term,
 * with the rule behind the line in plain words. Pure: no React, no formatting policy beyond the rounding rule that
 * the whole explorer follows — costs round UP to the cent, payouts and P&L round DOWN. */

const CENT = 10_000n;
const SIX = 1_000_000n;
/** Stock Token amounts show six decimals, floored: a 0.01-share unit is 1e16 base units, so six places always
 * resolve a whole unit and never invent a fraction the chain does not pay. */
const TOKEN_PLACES = 6n;

export type GasEstimate = {
  /** Transactions the buy sends now: `take`, plus one `approve` when the allowance is short (TradeTicket.tsx). */
  transactions: number;
  /** Native-currency cost of those transactions from the wallet's estimate, in wei; null when the wallet could
   * not estimate (for example before an approval exists). NEVER a constant. */
  wei: bigint | null;
  symbol: string;
};

export type ReceiptLine = {
  key: string;
  label: string;
  /** The figure, already formatted with its unit. */
  value: string;
  /** How the figure was reached, in the scenario's own numbers. */
  note: string;
  /** The contract rule, written from §1.1 of the design, for the info affordance. */
  rule: string;
  /** A deduction is rendered with a leading minus. */
  deduction?: boolean;
};

export type ReceiptSection = { title: string; lines: ReceiptLine[]; total: ReceiptLine };

export type ScenarioFigures = {
  price: bigint;
  grossPerUnit: bigint;
  feePerUnit: bigint;
  netPerUnit: bigint;
  /** In-kind value for a call (Stock Token base units × units); USDG for a put. */
  netTotal: bigint;
  /** USDG value at the settlement price, before conversion: what `payoutAt` returns. */
  payoutValue: bigint;
  /** Calls only: the delivered-USDG band; null for a put. */
  band: UsdgBand | null;
  /** P&L at the band's low end (a put: the same as `pnlHigh`). */
  pnlLow: Pnl;
  pnlHigh: Pnl;
};

export type PayoffReceipt = {
  pay: ReceiptSection;
  get: ReceiptSection;
  /** One line for a collapsed receipt: the total paid and the net at this price. */
  summary: string;
  figures: ScenarioFigures;
};

export type PayoffReceiptInput = {
  ticker: string;
  position: PayoffPosition;
  cost: BuyCost;
  fees: TakerFeeParams;
  price: bigint;
  terms: ConversionTerms;
  gas: GasEstimate | null;
};

function group(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** USDG to the cent. Costs round up, payouts and P&L down; a negative amount keeps its sign and rounds away
 * from zero when `direction` is "down" (a loss is never shown smaller than it is). */
export function formatUsdgCents(raw: bigint, direction: "up" | "down"): string {
  const negative = raw < 0n;
  const amount = negative ? -raw : raw;
  const cents = direction === "up" || negative ? (amount + CENT - 1n) / CENT : amount / CENT;
  return `${negative ? "−" : ""}${group(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A signed P&L to the cent, floored (a gain shows no more than the chain pays, a loss no less). */
export function formatSignedUsdg(raw: bigint): string {
  return `${raw > 0n ? "+" : ""}${formatUsdgCents(raw, "down")}`;
}

/** A USDG-6 price, exactly, with at least cents. */
export function formatPriceExact(raw: bigint): string {
  const whole = group(raw / SIX);
  const fraction = (raw % SIX).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}

/** Stock Token base units (18 dp) to six places, floored. */
export function formatTokens(raw: bigint): string {
  if (raw < 0n) throw new RangeError("tokens must be nonnegative");
  const scale = 10n ** (18n - TOKEN_PLACES);
  const scaled = raw / scale;
  const unit = 10n ** TOKEN_PLACES;
  return `${group(scaled / unit)}.${(scaled % unit).toString().padStart(Number(TOKEN_PLACES), "0")}`;
}

/** Whole percent, floored (a −0.4 % loss shows as −1 %). Null when nothing was paid. */
export function formatPct(pct: number | null): string {
  if (pct === null) return "—";
  const whole = Math.floor(pct);
  return `${whole > 0 ? "+" : whole < 0 ? "−" : ""}${Math.abs(whole)} %`;
}

export function formatMultiple(multiple: number | null): string {
  return multiple === null ? "—" : `${multiple.toFixed(2)}×`;
}

/** Native gas in whole-unit decimals, six places, floored. */
export function formatNative(wei: bigint, symbol: string): string {
  const scaled = wei / 10n ** 12n;
  return `${scaled / SIX}.${(scaled % SIX).toString().padStart(6, "0")} ${symbol}`;
}

function bpsPercent(bps: number): string {
  const text = (bps / 100).toFixed(2).replace(/\.?0+$/, "");
  return `${text} %`;
}

/** The scenario's numbers, computed in base units from the same functions the slider uses. */
export function scenarioFigures(position: PayoffPosition, cost: bigint, price: bigint, terms: ConversionTerms): ScenarioFigures {
  const grossPerUnit = grossPayoutPerUnit(position.isPut, position.strike, price);
  const feePerUnit = exerciseFeePerUnit(grossPerUnit, collateralPerUnit(position.isPut, position.strike), position.exerciseFeeBps);
  const netPerUnit = grossPerUnit - feePerUnit;
  const netTotal = netPerUnit * position.units;
  const pnlHigh = pnlAt(price, position, cost);
  const payoutValue = pnlHigh.pnl + cost;
  if (position.isPut) return { price, grossPerUnit, feePerUnit, netPerUnit, netTotal, payoutValue, band: null, pnlLow: pnlHigh, pnlHigh };
  const band = usdgPayoutBand(payoutValue, terms.slippageBps, terms.routeFeeBps);
  const lowPnl = band.low - cost;
  const pnlLow: Pnl = cost === 0n ? { pnl: lowPnl, pct: null, multiple: null } : {
    pnl: lowPnl,
    pct: Number(floorDiv(lowPnl * 10_000n, cost)) / 100,
    multiple: Number((band.low * 100n) / cost) / 100,
  };
  return { price, grossPerUnit, feePerUnit, netPerUnit, netTotal, payoutValue, band, pnlLow, pnlHigh };
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const q = numerator / denominator;
  return (numerator % denominator !== 0n && (numerator < 0n) !== (denominator < 0n)) ? q - 1n : q;
}

/** The band as copy: "between A and B USDG", or one figure when the band has no width. */
export function bandText(band: UsdgBand): string {
  return band.low === band.high
    ? `${formatUsdgCents(band.high, "down")} USDG`
    : `between ${formatUsdgCents(band.low, "down")} and ${formatUsdgCents(band.high, "down")} USDG`;
}

/** A P&L range as copy, collapsing when both ends agree. */
export function pnlRangeText(low: Pnl, high: Pnl): string {
  if (low.pnl === high.pnl) return `${formatSignedUsdg(high.pnl)} USDG (${formatPct(high.pct)}, ${formatMultiple(high.multiple)})`;
  return `${formatSignedUsdg(low.pnl)} to ${formatSignedUsdg(high.pnl)} USDG ` +
    `(${formatPct(low.pct)} to ${formatPct(high.pct)}, ${formatMultiple(low.multiple)} to ${formatMultiple(high.multiple)})`;
}

const RULES = {
  premium: "Premium is the ask price times the shares, exact: order prices are multiples of the contract's price tick, and every fill of the take is summed.",
  takerFee: "One taker fee per buy, on the total premium: the lesser of the flat fee or the fee cap's share of the premium. A fee discount, if one is ever set, can only lower it.",
  gas: "Network gas is paid in the chain's native currency and estimated by your wallet. It is not a protocol fee and it is not a constant.",
  maxLoss: "A bought option never owes more than it cost. Out of the money it expires worthless and you lose exactly this.",
  settlement: "Your option settles on the average price of the last 30 minutes before expiry (16:00 New York), from the market's price sources — not on the price at the moment of expiry.",
  grossPut: "A winning put pays (strike − settlement price) per share, in USDG, floored to the base unit.",
  grossCall: "A winning call pays (settlement price − strike) ÷ settlement price of a share, in Stock Tokens, floored to the base unit. It is paid in kind from the writer's locked share.",
  exerciseFee: "The exercise fee is the series' rate on the collateral the writer locked, and never more than 10 % of the gross payout. It comes out of your payout only when you win.",
  net: "Net payout is gross minus the exercise fee, fixed at settlement and owed to you at redemption.",
  paidPut: "A winning put pays USDG to your wallet, or to your Clearinghouse balance if you prefer or if the transfer cannot complete.",
  paidCall: "Unless you choose to keep tokens, the app tries to convert a call's Stock Tokens to USDG at no worse than the conversion floor and hands you the tokens if that is not possible. The floor is measured at the settlement price or a higher live price.",
  redeemGas: "Redemption can be sent by anyone, so a keeper usually pays it. If you redeem yourself it is one transaction.",
  pnl: "Net P&L is what you can get minus what you paid. Payouts round down, costs round up, so a shown gain is never more than the chain pays.",
} as const;

/** Build the receipt for one scenario price. */
export function buildPayoffReceipt(input: PayoffReceiptInput): PayoffReceipt {
  const { ticker, position, cost, fees, price, terms, gas } = input;
  if (price < 0n) throw new RangeError("price must be nonnegative");
  if (cost.filledUnits !== position.units) throw new RangeError("the receipt describes the quoted fill; units must match");
  const shares = formatShares(position.units);
  const feeCapShare = (cost.premium * BigInt(fees.takerFeeCapBps)) / BPS;
  const gasLine: ReceiptLine = {
    key: "gas", label: "Network gas",
    value: gas === null ? "shown by your wallet" : gas.wei === null ? "shown by your wallet" : `≈ ${formatNative(gas.wei, gas.symbol)}`,
    note: gas === null ? "1 transaction now, plus an approval if your USDG allowance is short (wallet estimate)"
      : `${gas.transactions} transaction${gas.transactions === 1 ? "" : "s"} now (wallet estimate)`,
    rule: RULES.gas,
  };
  const pay: ReceiptSection = {
    title: "What you pay now",
    lines: [
      { key: "premium", label: "Premium", value: `${formatUsdgCents(cost.premium, "up")} USDG`,
        note: `${position.units.toString()} × 0.01-share units at ${cost.averagePrice === null ? "—" : formatPriceExact(cost.averagePrice)} USDG/share average ask`,
        rule: RULES.premium },
      { key: "takerFee", label: "Taker fee", value: `${formatUsdgCents(cost.fee, "up")} USDG`,
        note: `the lesser of ${formatUsdgCents(fees.takerFeeFlat, "up")} USDG or ${bpsPercent(fees.takerFeeCapBps)} of premium (${formatUsdgCents(feeCapShare, "up")})`,
        rule: RULES.takerFee },
      gasLine,
    ],
    total: { key: "maxLoss", label: "Total = your max loss", value: `${formatUsdgCents(cost.cost, "up")} USDG`,
      note: "premium + taker fee; gas is on top", rule: RULES.maxLoss },
  };

  const figures = scenarioFigures(position, cost.cost, price, terms);
  const priceText = formatPriceExact(price);
  const strikeText = formatPriceExact(position.strike);
  const side = position.isPut ? "put" : "call";
  const heading = `What you can get at settlement (if ${ticker} ends at $${priceText}; strike ${strikeText} ${side})`;
  const lines: ReceiptLine[] = [];
  if (position.isPut) {
    const collateral = collateralPerUnit(true, position.strike) * position.units;
    lines.push({ key: "gross", label: "Gross payout",
      value: `${formatUsdgCents(figures.grossPerUnit * position.units, "down")} USDG`,
      note: figures.grossPerUnit === 0n
        ? `${priceText} is not below the ${strikeText} strike, so the put pays nothing`
        : `${shares} share${position.units === 100n ? "" : "s"} × (${strikeText} − ${priceText})`,
      rule: RULES.grossPut });
    lines.push({ key: "exerciseFee", label: "Exercise fee", deduction: true,
      value: `${formatUsdgCents(figures.feePerUnit * position.units, "up")} USDG`,
      note: `${bpsPercent(position.exerciseFeeBps)} of the ${formatUsdgCents(collateral, "down")} USDG locked, never more than 10 % of the payout`,
      rule: RULES.exerciseFee });
    lines.push({ key: "net", label: "Net payout", value: `${formatUsdgCents(figures.netTotal, "down")} USDG`, note: "gross − exercise fee", rule: RULES.net });
    lines.push({ key: "paid", label: "Paid as", value: "USDG", note: "to your wallet at redemption", rule: RULES.paidPut });
  } else {
    lines.push({ key: "gross", label: "Gross payout",
      value: `${formatTokens(figures.grossPerUnit * position.units)} ${ticker}`,
      note: figures.grossPerUnit === 0n
        ? `${priceText} is not above the ${strikeText} strike, so the call pays nothing`
        : `${shares} share${position.units === 100n ? "" : "s"} × (${priceText} − ${strikeText}) ÷ ${priceText}`,
      rule: RULES.grossCall });
    lines.push({ key: "exerciseFee", label: "Exercise fee", deduction: true,
      value: `${formatTokens(figures.feePerUnit * position.units)} ${ticker}`,
      note: `${bpsPercent(position.exerciseFeeBps)} of the ${shares} share${position.units === 100n ? "" : "s"} locked, never more than 10 % of the payout`,
      rule: RULES.exerciseFee });
    lines.push({ key: "net", label: "Net payout", value: `${formatTokens(figures.netTotal)} ${ticker}`, note: "gross − exercise fee, in Stock Tokens", rule: RULES.net });
    const band = figures.band!;
    const worst = Number(BPS) - band.floorBps;
    lines.push({ key: "asUsdg", label: "As USDG", value: bandText(band),
      note: `worth ${formatUsdgCents(band.high, "down")} at the settlement price; at worst about ${bpsPercent(worst)} under it` +
        `${worst === MAX_PAYOUT_SLIPPAGE_CEIL_BPS ? " (the contract ceiling)" : ""}, or the tokens themselves`,
      rule: RULES.paidCall });
  }
  lines.push({ key: "redeemGas", label: "Redeem gas", value: "usually paid by a keeper", note: "if you redeem yourself, 1 transaction", rule: RULES.redeemGas });
  const get: ReceiptSection = {
    title: heading,
    lines,
    total: { key: "pnl", label: "Net P&L", value: pnlRangeText(figures.pnlLow, figures.pnlHigh), note: "what you can get − what you paid", rule: RULES.pnl },
  };
  const summary = `Total ${formatUsdgCents(cost.cost, "up")} USDG · at $${priceText}: ${figures.pnlLow.pnl === figures.pnlHigh.pnl
    ? `${formatSignedUsdg(figures.pnlHigh.pnl)} USDG`
    : `${formatSignedUsdg(figures.pnlLow.pnl)} to ${formatSignedUsdg(figures.pnlHigh.pnl)} USDG`}`;
  return { pay, get, summary, figures };
}

export const SETTLEMENT_RULE = RULES.settlement;
