/**
 * How a number is SHOWN. One set
 * of rules, used by the existing display formatters in lib/format.ts, so every page that already calls them follows
 * them without a change of its own:
 *
 *   money         at most 2 decimals, none when whole: 12, 12.30, 0.05. From 10,000 up it is compact: 12.5K, 250K,
 *                 1.2M. A caller that asks for more decimals (a per-share figure) gets up to that many, trailing
 *                 zeros dropped past the cents: 0.04332, 1.50.
 *   price         where prices are compared (ask, bid, cost per share): always 2 decimals at 1 and up (12.00); under
 *                 1, 3 significant digits (0.0123, 0.50). Never compact.
 *   quantity      shares, units, Stock Tokens: at most 4 decimals, trailing zeros dropped (2.5, 1, 0.0012), compact
 *                 from 10,000 like money.
 *   percent       at most 1 decimal, a trailing zero dropped: 25%, 12.5%, 0%.
 *   tiny          a non-zero amount below the smallest step shown reads "<0.01" (money), "<0.0001" (price and
 *                 quantity) or "<0.1%" (percent). Never a run of zeros, and never "0" for something that is not zero.
 *
 * Every rule truncates toward zero, as formatAmount always has: a display never shows more than the chain holds, and
 * 999,999.99 compacts to 999.9K, not 1000K. The exact values stay with the exact formatters (formatAmount,
 * payoffCard.formatUsdg, formatPriceExact) for inputs, transaction review and tooltips.
 *
 * No imports: the rules are integer arithmetic on base units, so nothing here goes through a float.
 */

/** Values from here up are compact (K, M, B). */
export const COMPACT_FROM = 10_000n;

const COMPACT_UNITS: ReadonlyArray<readonly [bigint, string]> = [
  [1_000_000_000n, "B"],
  [1_000_000n, "M"],
  [1_000n, "K"],
];

export type DisplayOptions = {
  /** The minus sign. ASCII "-" by default, as formatAmount; the payoff explorer uses "−". */
  minus?: string;
};

const pow10 = (n: number): bigint => 10n ** BigInt(n);

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** |value| truncated to `dp` decimals: the whole part and exactly `dp` fraction digits. */
function truncated(abs: bigint, decimals: number, dp: number): { whole: bigint; fraction: string } {
  const scale = pow10(decimals);
  const whole = abs / scale;
  const fraction = dp === 0 ? "" : (((abs % scale) * pow10(dp)) / scale).toString().padStart(dp, "0");
  return { whole, fraction };
}

/** 12,549.99 -> "12.5K"; null below COMPACT_FROM. One decimal, truncated, dropped when zero. */
function compact(abs: bigint, decimals: number): string | null {
  const scale = pow10(decimals);
  if (abs / scale < COMPACT_FROM) return null;
  for (const [unit, suffix] of COMPACT_UNITS) {
    if (abs / scale >= unit) {
      const tenths = (abs * 10n) / (unit * scale);
      const rest = tenths % 10n;
      return `${group((tenths / 10n).toString())}${rest === 0n ? "" : `.${rest}`}${suffix}`;
    }
  }
  return null;
}

/** The smallest step `dp` decimals can show, as the "below this" floor: 2 -> "<0.01", 0 -> "<1". */
function floorText(dp: number): string {
  return dp === 0 ? "<1" : `<0.${"0".repeat(dp - 1)}1`;
}

function sign(raw: bigint, body: string, opts?: DisplayOptions): string {
  return raw < 0n ? `${opts?.minus ?? "-"}${body}` : body;
}

/**
 * Money: at most `maxDecimals` (default 2) decimals. At 2 the cents show only when they are not zero ("12", "12.30").
 * Above 2 the trailing zeros past the cents are dropped ("0.04332", "1.50"). Compact from 10,000; "<0.01" below one
 * step; "0" only for zero.
 */
export function displayMoney(raw: bigint, decimals: number, opts?: DisplayOptions & { maxDecimals?: number }): string {
  if (raw === 0n) return "0";
  const abs = raw < 0n ? -raw : raw;
  const dp = opts?.maxDecimals ?? 2;
  const big = compact(abs, decimals);
  if (big !== null) return sign(raw, big, opts);
  // A per-share figure may ask for up to 6 decimals, but no more than three zeros ever lead: below 0.0001 is "<0.0001".
  if (dp > 4 && abs < pow10(decimals) / 10_000n) return sign(raw, floorText(4), opts);
  const { whole, fraction } = truncated(abs, decimals, dp);
  if (whole === 0n && /^0*$/.test(fraction)) return sign(raw, floorText(dp), opts);
  let shown = /^0*$/.test(fraction) ? "" : fraction;
  if (shown.length > 2) shown = shown.replace(/0+$/, "").padEnd(2, "0");
  return sign(raw, shown ? `${group(whole.toString())}.${shown}` : group(whole.toString()), opts);
}

/**
 * A price that sits next to other prices: 2 decimals always at 1 and up ("12.00", "1,234.50"), 3 significant digits
 * under 1 with at least 2 decimals ("0.0123", "0.50"), "<0.0001" below that. Never compact: an ask and a bid must line
 * up digit for digit.
 */
export function displayPrice(raw: bigint, decimals: number, opts?: DisplayOptions): string {
  if (raw === 0n) return "0.00";
  const abs = raw < 0n ? -raw : raw;
  const scale = pow10(decimals);
  if (abs >= scale) {
    const { whole, fraction } = truncated(abs, decimals, 2);
    return sign(raw, `${group(whole.toString())}.${fraction}`, opts);
  }
  const digits = abs.toString().padStart(decimals, "0");
  const lead = digits.search(/[1-9]/);
  if (lead >= 4) return sign(raw, "<0.0001", opts);
  const fraction = digits.slice(0, lead + 3).replace(/0+$/, "").padEnd(2, "0");
  return sign(raw, `0.${fraction}`, opts);
}

/**
 * Every digit, for a figure that must be exact (a transaction's amounts, an error that quotes them, strike − spot =
 * distance digit for digit): all `decimals` digits kept, trailing zeros past `minDecimals` dropped ("3.00", "0.123456",
 * "1,234.5678"). No floor, no compaction, no truncation.
 */
export function displayExact(raw: bigint, decimals: number, opts?: DisplayOptions & { minDecimals?: number }): string {
  const abs = raw < 0n ? -raw : raw;
  const { whole, fraction } = truncated(abs, decimals, decimals);
  const min = opts?.minDecimals ?? 2;
  const shown = fraction.replace(/0+$/, "").padEnd(Math.min(min, decimals), "0");
  const body = shown ? `${group(whole.toString())}.${shown}` : group(whole.toString());
  return raw < 0n ? sign(raw, body, opts) : body;
}

/**
 * A count of shares, units or tokens: at most `maxDecimals` (default 4) decimals, trailing zeros dropped ("2.5", "1"),
 * compact from 10,000, "<0.0001" below one step.
 */
export function displayQuantity(raw: bigint, decimals: number, opts?: DisplayOptions & { maxDecimals?: number }): string {
  if (raw === 0n) return "0";
  const abs = raw < 0n ? -raw : raw;
  const dp = opts?.maxDecimals ?? 4;
  const big = compact(abs, decimals);
  if (big !== null) return sign(raw, big, opts);
  const { whole, fraction } = truncated(abs, decimals, dp);
  const shown = fraction.replace(/0+$/, "");
  if (whole === 0n && shown === "") return sign(raw, floorText(dp), opts);
  return sign(raw, shown ? `${group(whole.toString())}.${shown}` : group(whole.toString()), opts);
}

/**
 * `numerator / denominator` as a percent: at most 1 decimal, a trailing zero dropped ("25%", "12.5%", "0%"), and
 * "<0.1%" for a non-zero ratio below a tenth of a percent. The caller passes the ratio of the two quantities, not a
 * float, so 0.3 never becomes 0.29999.
 */
export function displayRatioPercent(numerator: bigint, denominator: bigint, opts?: DisplayOptions): string {
  if (denominator === 0n) throw new RangeError("displayRatioPercent: zero denominator");
  if (numerator === 0n) return "0%";
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const tenths = (n * 1000n) / d;
  const body = tenths === 0n ? "<0.1%" : `${group((tenths / 10n).toString())}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`}%`;
  return negative ? `${opts?.minus ?? "-"}${body}` : body;
}

/** A percent held as a number (12.34 means 12.34%): at most 1 decimal, truncated, the same "<0.1%" floor. */
export function displayPercent(percent: number, opts?: DisplayOptions): string {
  if (!Number.isFinite(percent)) return "—";
  // Through 1e6ths first, so a float like 2.3 (2.2999999...) truncates to 2.3, not 2.2.
  const millionths = BigInt(Math.round(percent * 1_000_000));
  return displayRatioPercent(millionths, 100_000_000n, opts);
}

/** Puts a dollar sign after the sign and the "<": "12" -> "$12", "<0.01" -> "<$0.01", "-5" -> "-$5". */
export function withDollar(text: string): string {
  const m = /^([-−]?)(<?)(.*)$/.exec(text);
  if (!m || text === "—") return text;
  return `${m[1]}${m[2]}$${m[3]}`;
}
