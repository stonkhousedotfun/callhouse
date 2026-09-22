/**
 * The maker program's names for the shared claim engine.
 *
 * T-133 moved the implementation to `rewardClaim.ts` so the lender program could use it without a
 * second copy. This file is a RE-EXPORT SHIM and holds no logic: every existing maker call site and
 * `makerRewards.test.ts` import from here unchanged, which is what makes the move checkable — if the
 * move broke anything, that test fails against the same OpenZeppelin reference vector it always used.
 *
 * Nothing here is maker-specific except the names. The engine validates amounts as decimal strings
 * and never interprets their scale; USDG's 6 decimals live in `rewardPrograms.ts`, for display only.
 */
export type { RewardClaim as MakerClaim, RewardEpochFile as MakerEpochFile } from "./rewardClaim";
export {
  parseRewardEpochFile as parseMakerEpochFile,
  rewardClaimProofValid as makerClaimProofValid,
  readRewardClaim as readMakerClaim,
  claimReward as claimMakerReward,
} from "./rewardClaim";
