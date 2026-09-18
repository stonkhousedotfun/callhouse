/**
 * The collateral rent a mint charges (INTERFACE_VERSION 7, c05), restated exactly as the contracts compute it
 * (callhouse-contracts `src/v2/lib/OptionMath.sol` mintFee / mintFeeRefund, v7 design §4.2). Pure; no chain, no clock.
 *
 * WHY THE KEEPER NEEDS IT. `Clearinghouse.mint` takes `units x collateralPerUnit` PLUS
 * `ceil(collateral x mintFeePpm x (expiry - now) / (1e6 x 7 days))` out of the writer's FREE collateral, and
 * `OrderBook._reserveCollateral` budgets exactly that for an AskWrite fill (and for a `writeToSell`). An account
 * holding exactly `units x collateralPerUnit` can no longer mint, and the book SKIPS its order rather than reverting:
 * a bot that sizes a write ask at `free / collateralPerUnit` advertises depth that is not there (codex's
 * V7-CONSUMER-INVENTORY, "rent changes fillability"). {maxWriteUnits} is the exact inverse.
 *
 * ROUNDING. The fee is rounded UP once per call, so `n x rentPerUnit` is an upper bound of `mintFee(n x cpu)` and
 * sizing against it under-advertises. {maxWriteUnits} instead searches the true predicate `need(n) <= free`, which is
 * what the book checks for one fill of the whole order. Two fills of n/2 each round twice and cost at most one base
 * unit more in total; a caller planning several fills out of one budget subtracts each fill's own {need}.
 *
 * UNITS: collateral-asset base units (18 dp for a call's Stock Token, 6 dp for a put's USDG); `remaining` seconds.
 */
import { MINT_FEE_PERIOD_S, PPM } from './cranker/constants.js';

/** `PPM x MINT_FEE_PERIOD`, the denominator both helpers divide by. */
const DENOM = PPM * BigInt(MINT_FEE_PERIOD_S);

const nonNegative = (x: bigint): bigint => (x > 0n ? x : 0n);

/**
 * OptionMath.mintFee: rent on `collateral` for `remaining` seconds, rounded UP (the protocol's favour, under one base
 * unit per call). 0 when any input is 0.
 */
export function mintFee(collateral: bigint, feePpm: number | bigint, remaining: number | bigint): bigint {
  const num = nonNegative(collateral) * nonNegative(BigInt(feePpm)) * nonNegative(BigInt(remaining));
  return num === 0n ? 0n : (num - 1n) / DENOM + 1n;
}

/** OptionMath.mintFeeRefund: the same product rounded DOWN, which is what `close` pays back before expiry. */
export function mintFeeRefund(collateral: bigint, feePpm: number | bigint, remaining: number | bigint): bigint {
  return (nonNegative(collateral) * nonNegative(BigInt(feePpm)) * nonNegative(BigInt(remaining))) / DENOM;
}

/** Seconds of life left at `now`, floored at 0 (at or after expiry a mint is closed and the rent is 0). */
export const remainingLife = (expiry: number, now: number): number => (expiry > now ? expiry - now : 0);

/**
 * What `OrderBook._reserveCollateral` consumes from a writer's free collateral for one fill of `units`:
 * collateral plus the rent on it, rounded up once — the same single rounding `Clearinghouse.mint` performs.
 */
export function collateralNeeded(units: bigint, collateralPerUnit: bigint, feePpm: number, remaining: number): bigint {
  const collateral = nonNegative(units) * nonNegative(collateralPerUnit);
  return collateral + mintFee(collateral, feePpm, remaining);
}

/**
 * Rent on ONE unit, rounded up: the per-unit figure `AutoRoller._plan` sizes with
 * (`free / (UNIT + feePerUnit)`). An upper bound of the per-unit share of {collateralNeeded}, so a size derived
 * from it always fills, never more.
 */
export const rentPerUnit = (collateralPerUnit: bigint, feePpm: number, remaining: number): bigint =>
  mintFee(collateralPerUnit, feePpm, remaining);

/**
 * The largest `units` whose {collateralNeeded} still fits in `free`: the exact capacity of a write-on-fill ask taken
 * in ONE fill, which is what `OrderBook.quoteTake` answers for the whole order.
 *
 * `need` is non-decreasing in `units` (both terms are), so a binary search over `[0, free / collateralPerUnit]` —
 * an upper bound, since `need(n) >= n x collateralPerUnit` — finds it in about 64 steps.
 */
export function maxWriteUnits(free: bigint, collateralPerUnit: bigint, feePpm: number, remaining: number): bigint {
  if (collateralPerUnit <= 0n || free <= 0n) return 0n;
  let lo = 0n;
  let hi = free / collateralPerUnit;
  if (feePpm <= 0 || remaining <= 0) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (collateralNeeded(mid, collateralPerUnit, feePpm, remaining) <= free) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}
