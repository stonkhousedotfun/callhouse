/** Pure reductions for optional ExpiryCalendar and KeeperRewards event sources. */

export function seriesTenor(isWeekly: boolean, specialAllowed: boolean): "weekly" | "special" | "daily" {
  return isWeekly ? "weekly" : specialAllowed ? "special" : "daily";
}

export function rewardTotal(previous: { count: number; amount: bigint } | null, paid: bigint) {
  if (paid < 0n) throw new Error("Negative keeper reward");
  return { count: (previous?.count ?? 0) + 1, amount: (previous?.amount ?? 0n) + paid };
}

export function bountyAmount(amount: bigint): bigint {
  if (amount < 0n) throw new Error("Negative keeper bounty");
  return amount;
}
