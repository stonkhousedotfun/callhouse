/**
 * Black–Scholes with r = 0, and the implied vol backed out of a quoted price.
 * The payoff chart's "value before expiry" curve is only honest if its value at spot is the price
 * the book is actually asking; a fixed vol (50 %) drew a $245 call at 1.02 against a 0.47 quote.
 *
 * Plain numbers, not bigints: this is a display estimate. Everything the user is paid is computed exactly in
 * `payoff.ts`; nothing here feeds a transaction.
 */

/** Seconds in the year the vol is quoted over. Calendar time: the curve only needs to be self-consistent. */
export const SECONDS_PER_YEAR = 365 * 86_400;
/** Solver bounds, annualised. Daily options near expiry can imply very high vols; above 1000 % the quote is
 * treated as unexplainable rather than fitted. */
export const VOL_MIN = 0.001;
export const VOL_MAX = 10;

export type BsInput = { isPut: boolean; spot: number; strike: number; years: number };

export type VolFailure =
  /** Zero or negative time left: only the expiry value exists. */
  | "no-time"
  /** The quote is below what the option is already worth at expiry (intrinsic). */
  | "below-intrinsic"
  /** The quote is at or above the model's ceiling (a call cannot be worth the stock; a put not the strike). */
  | "above-max"
  /** Above intrinsic but below the minimum-vol price: too cheap to fit inside the bounds. */
  | "below-min-vol"
  /** A non-finite or non-positive input. */
  | "invalid";

export type VolResult = { ok: true; vol: number } | { ok: false; reason: VolFailure };

/** Standard normal CDF: Hart (1968) algorithm 5666 as given by G. West, "Better approximations to cumulative
 * normal functions" (2005), accurate to double precision. A 1e-7 approximation was measurably too loose: it
 * moved a 7.97 at-the-money price in the sixth significant figure. */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let tail: number;
  if (z > 37) tail = 0;
  else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      const num = ((((((0.0352624965998911 * z + 0.700383064443688) * z + 6.37396220353165) * z +
        33.912866078383) * z + 112.079291497871) * z + 221.213596169931) * z + 220.206867912376);
      const den = (((((((0.0883883476483184 * z + 1.75566716318264) * z + 16.064177579207) * z +
        86.7807322029461) * z + 296.564248779674) * z + 637.333633378831) * z + 793.826512519948) * z + 440.413735824752);
      tail = e * num / den;
    } else {
      const b = z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 0.65))));
      tail = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

export function intrinsic({ isPut, spot, strike }: Pick<BsInput, "isPut" | "spot" | "strike">): number {
  return Math.max(isPut ? strike - spot : spot - strike, 0);
}

/** Black–Scholes price per share with r = 0. At zero time or zero vol it is the intrinsic value. */
export function bsPrice(input: BsInput, vol: number): number {
  const { isPut, spot, strike, years } = input;
  if (!(spot > 0) || !(strike > 0)) throw new RangeError("spot and strike must be positive");
  if (!(vol >= 0) || !Number.isFinite(vol)) throw new RangeError("vol must be a nonnegative finite number");
  if (!(years > 0) || vol === 0) return intrinsic(input);
  const sd = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + sd * sd / 2) / sd;
  const d2 = d1 - sd;
  const call = spot * normCdf(d1) - strike * normCdf(d2);
  // Put–call parity at r = 0 keeps both legs on the same numerical footing.
  const value = isPut ? call - spot + strike : call;
  return Math.max(value, intrinsic(input));
}

/** Vega per unit vol (r = 0), for the Newton step. */
function vega({ spot, strike, years }: BsInput, vol: number): number {
  const sd = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + sd * sd / 2) / sd;
  return spot * Math.sqrt(years) * Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
}

/**
 * The vol at which `bsPrice` equals `price`. Safeguarded Newton inside a shrinking bisection bracket, so it
 * always terminates inside [VOL_MIN, VOL_MAX]. The price is monotone increasing in vol, which is what makes the
 * bracket valid. Returns a reason instead of a vol whenever no vol in the bounds reproduces the price.
 */
export function impliedVol(input: BsInput, price: number): VolResult {
  const { spot, strike, years, isPut } = input;
  if (![spot, strike, years, price].every(Number.isFinite) || !(spot > 0) || !(strike > 0) || !(price > 0)) {
    return { ok: false, reason: "invalid" };
  }
  if (!(years > 0)) return { ok: false, reason: "no-time" };
  const tolerance = 1e-10 * Math.max(1, price);
  if (price < intrinsic(input) - tolerance) return { ok: false, reason: "below-intrinsic" };
  if (price >= (isPut ? strike : spot)) return { ok: false, reason: "above-max" };
  let low = VOL_MIN;
  let high = VOL_MAX;
  if (bsPrice(input, low) > price + tolerance) return { ok: false, reason: "below-min-vol" };
  if (bsPrice(input, high) < price - tolerance) return { ok: false, reason: "above-max" };
  let vol = 0.5;
  for (let i = 0; i < 200; i++) {
    const diff = bsPrice(input, vol) - price;
    if (Math.abs(diff) <= tolerance) return { ok: true, vol };
    if (diff > 0) high = vol;
    else low = vol;
    const v = vega(input, vol);
    const newton = v > 0 ? vol - diff / v : NaN;
    // Take the Newton step only while it stays strictly inside the bracket; otherwise bisect.
    vol = newton > low && newton < high ? newton : (low + high) / 2;
    if (high - low < 1e-12) break;
  }
  return Math.abs(bsPrice(input, vol) - price) <= 1e-6 * Math.max(1, price)
    ? { ok: true, vol }
    : { ok: false, reason: "below-min-vol" };
}

/** Plain-language reason, for the chart's fallback caption. */
export const VOL_FAILURE_TEXT: Record<VolFailure, string> = {
  "no-time": "no time is left before expiry",
  "below-intrinsic": "the quote is below what the option is worth at expiry",
  "above-max": "the quote is too high for the model to explain",
  "below-min-vol": "the quote is too low for the model to explain",
  invalid: "the quote or price is missing",
};
