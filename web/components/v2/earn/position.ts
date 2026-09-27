/**
 * When the Earn page shows "Your position".
 *
 * The card holds the only Withdraw form and the auto-roll Pause button, so hiding it must never strand money or a
 * running strategy. It shows when the wallet has anything here (free or locked collateral, an active auto-roll, or
 * premium already earned) AND whenever a read failed, because an unreadable balance or roll state is not an empty
 * one: the withdrawal re-checks the free balance on chain before signing, and Pause re-reads the roll position.
 */
export type EarnPositionFacts = {
  free: bigint | null;
  locked: bigint | null;
  autoRollActive: boolean;
  lifetimePremium: bigint | null;
  balanceUnreadable: boolean;
  rollUnreadable: boolean;
};

export function hasEarnPosition(facts: EarnPositionFacts): boolean {
  return facts.balanceUnreadable || facts.rollUnreadable || facts.autoRollActive ||
    (facts.free ?? 0n) > 0n || (facts.locked ?? 0n) > 0n || (facts.lifetimePremium ?? 0n) > 0n;
}
