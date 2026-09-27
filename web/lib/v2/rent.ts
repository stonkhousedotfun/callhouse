/** v8 writer collateral budget, including the series-pinned nonzero rent dial. One rounding per fill. */
export type RentTerms = { collateralPerUnit: bigint; mintFeePpm: number; expiry: number; snapshotTimestamp: number; mintCutoff?: number };
export const MINT_FEE_PERIOD = 604_800n;
const DENOMINATOR = 1_000_000n * MINT_FEE_PERIOD;
export const MAX_UNITS = (1n << 64n) - 1n;

export function mintRent(units: bigint, terms: RentTerms): bigint {
  if (units < 0n || units > MAX_UNITS || terms.collateralPerUnit <= 0n ||
      !Number.isSafeInteger(terms.mintFeePpm) || terms.mintFeePpm < 0 || terms.mintFeePpm > 5_000 ||
      !Number.isSafeInteger(terms.expiry) || !Number.isSafeInteger(terms.snapshotTimestamp) || terms.snapshotTimestamp < 0)
    throw new RangeError("Invalid writer rent terms");
  const remaining = BigInt(Math.max(0, terms.expiry - terms.snapshotTimestamp));
  const numerator = units * terms.collateralPerUnit * BigInt(terms.mintFeePpm) * remaining;
  return (numerator + DENOMINATOR - 1n) / DENOMINATOR;
}

export function writerCollateralNeed(units: bigint, terms: RentTerms): bigint {
  return units * terms.collateralPerUnit + mintRent(units, terms);
}

/** Largest single fill affordable at the balance's pinned timestamp. */
export function writerCapacity(free: bigint, terms: RentTerms, maximum = MAX_UNITS): bigint {
  mintRent(0n, terms);
  if (free < 0n || maximum < 0n || maximum > MAX_UNITS) throw new RangeError("Invalid writer budget");
  if (terms.snapshotTimestamp >= terms.expiry || (terms.mintCutoff !== undefined && terms.snapshotTimestamp >= terms.mintCutoff)) return 0n;
  let lo = 0n;
  let hi = free / terms.collateralPerUnit < maximum ? free / terms.collateralPerUnit : maximum;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (writerCollateralNeed(mid, terms) <= free) lo = mid; else hi = mid - 1n;
  }
  return lo;
}
