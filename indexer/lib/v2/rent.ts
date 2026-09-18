/** Exact v7 collateral rent. All amounts remain in the series' native collateral asset. */
export const MINT_FEE_PERIOD = 604_800n;
export const MINT_FEE_CEIL_PPM = 5_000;
const DENOMINATOR = 1_000_000n * MINT_FEE_PERIOD;
const MAX_UNITS = (1n << 64n) - 1n;

export function mintRent(collateral: bigint, ppm: number, remaining: bigint): bigint {
  if (collateral < 0n || !Number.isInteger(ppm) || ppm < 0 || ppm > MINT_FEE_CEIL_PPM)
    throw new RangeError("invalid collateral rent input");
  if (remaining <= 0n || ppm === 0 || collateral === 0n) return 0n;
  const numerator = collateral * BigInt(ppm) * remaining;
  return (numerator - 1n) / DENOMINATOR + 1n;
}

export function collateralWithRent(units: bigint, perUnit: bigint, ppm: number, remaining: bigint): bigint {
  if (units < 0n || perUnit <= 0n) throw new RangeError("invalid collateral requirement");
  const collateral = units * perUnit;
  return collateral + mintRent(collateral, ppm, remaining);
}

/** Max whole units for ONE fill; ceiling once per fill, never once per unit. */
export function rentCapacity(free: bigint, perUnit: bigint, ppm: number, remaining: bigint, cap = MAX_UNITS): bigint {
  if (free < 0n || perUnit <= 0n || cap < 0n) throw new RangeError("invalid collateral capacity");
  let lo = 0n;
  let hi = free / perUnit < cap ? free / perUnit : cap;
  if (hi > MAX_UNITS) hi = MAX_UNITS;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (collateralWithRent(mid, perUnit, ppm, remaining) <= free) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}
