/**
 * The payoff explorer's number formatters, as a leaf with NO imports (not even type-only), so the site can twin
 * this file and `payoffChart.ts` byte for byte. One definition of each: `payoffCard.ts` and
 * `payoffReceipt.ts` re-export these rather than keeping their own. The rounding rule is the explorer's: costs
 * round UP to the cent, payouts and P&L round DOWN.
 */

const CENT = 10_000n;
const SIX = 1_000_000n;

/** Thousands separators on a non-negative integer. */
export function group(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Contract units (0.01 share each) as shares, trailing zeros dropped: 250n -> "2.5", 100n -> "1". */
export function formatShares(units: bigint): string {
  const whole = units / 100n;
  const fraction = (units % 100n).toString().padStart(2, "0");
  return fraction === "00" ? whole.toString() : `${whole}.${fraction}`.replace(/0$/, "");
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
