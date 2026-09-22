import type { Level } from "./api-types";
import { type TakerFeeParams } from "./payoff";
import type { RentTerms } from "./rent";
import { buyQuote, flattenAsks, type BuyQuote } from "./ticket";

const USDG_SCALE = 1_000_000n;
const MAX_UNITS = (1n << 64n) - 1n;

export const DEFAULT_BUY_BUDGET = "10";
export const BUY_BUDGET_PRESETS = ["10", "50", "200"] as const;

/** Parse a positive USDG amount without passing through floating point. */
export function parseUsdgBudget(value: string): bigint | null {
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  const [whole = "0", fraction = ""] = value.trim().split(".");
  const raw = BigInt(whole) * USDG_SCALE + BigInt(fraction.padEnd(6, "0") || "0");
  return raw > 0n ? raw : null;
}

type QuoteArgs = {
  levels: readonly Level[];
  fees: TakerFeeParams;
  toleranceBps: number;
  taker?: string;
  rent?: RentTerms;
};

function quoteUpperBound({ levels, taker }: QuoteArgs): bigint {
  const advertised = flattenAsks(levels, taker).reduce((total, ask) =>
    total + (ask.onChainRemainingUnits > 0n ? ask.onChainRemainingUnits : 0n), 0n);
  return advertised < MAX_UNITS ? advertised : MAX_UNITS;
}

/**
 * Find the largest fully fillable unit count accepted by a monotone quote predicate.
 * The production quote path remains authoritative: every probe walks the same ordered asks,
 * writer-collateral budget and fee schedule used by the ticket.
 */
function highestQuote(args: QuoteArgs, accepts: (quote: BuyQuote) => boolean): BuyQuote | null {
  let low = 0n;
  let high = quoteUpperBound(args);

  while (low < high) {
    const units = (low + high + 1n) / 2n;
    const quote = buyQuote(args.levels, units, args.fees, args.toleranceBps, args.taker, args.rent);
    if (quote.buy.filledUnits === units && quote.buy.unfilledUnits === 0n && accepts(quote)) {
      low = units;
    } else {
      high = units - 1n;
    }
  }
  if (low === 0n) return null;
  const quote = buyQuote(args.levels, low, args.fees, args.toleranceBps, args.taker, args.rent);
  return quote.buy.filledUnits === low && quote.buy.unfilledUnits === 0n && accepts(quote) ? quote : null;
}

/** Largest fully fillable quote whose premium plus taker fee does not exceed the USDG budget. */
export function buyQuoteForBudget(levels: readonly Level[], budget: bigint, fees: TakerFeeParams,
  toleranceBps = 200, taker?: string, rent?: RentTerms): BuyQuote | null {
  if (budget <= 0n) return null;
  try {
    return highestQuote({ levels, fees, toleranceBps, taker, rent }, (quote) => quote.buy.cost <= budget);
  } catch {
    return null;
  }
}

/** Largest fully fillable quote across the currently usable ask ladder. */
export function maxBuyQuote(levels: readonly Level[], fees: TakerFeeParams,
  toleranceBps = 200, taker?: string, rent?: RentTerms): BuyQuote | null {
  try {
    return highestQuote({ levels, fees, toleranceBps, taker, rent }, () => true);
  } catch {
    return null;
  }
}
