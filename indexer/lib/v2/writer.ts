/** Writer totals are in USDG base units. Short collateral for calls is Stock Token
 * (18 decimals); puts lock USDG. A call's locked value is marked at the strike
 * before settlement and at the final settlement price when assignment is known. */
export function collateralValue(units: bigint, strike: bigint, isPut: boolean): bigint {
  if (units < 0n || strike < 0n) throw new Error("negative writer collateral");
  // One option unit represents 0.01 share. Put collateral is strike/100 USDG;
  // call collateral is 1e16 Stock Token, marked at strike for a stable entry basis.
  return units * strike / 100n;
}

export function assignedValue(
  units: bigint, strike: bigint, settlementPrice: bigint, isPut: boolean,
  shortPayoutUsdg: bigint,
): bigint {
  if (units < 0n || shortPayoutUsdg < 0n || settlementPrice < 0n) throw new Error("negative writer payout");
  const collateral = collateralValue(units, isPut ? strike : settlementPrice, isPut);
  return collateral > shortPayoutUsdg ? collateral - shortPayoutUsdg : 0n;
}

export function primaryPremiumReceived(
  premium: bigint, sellerFee: bigint, makerRebate: bigint, takerFee: bigint,
  sellerIsMaker: boolean, sellerIsTaker: boolean,
): bigint {
  return premium - sellerFee + (sellerIsMaker ? makerRebate : 0n) - (sellerIsTaker ? takerFee : 0n);
}
