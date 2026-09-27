/**
 * The lender program's names for the shared claim engine, plus its own configuration.
 *
 * The lender program pays Earn-vault suppliers in $STONKHOUSE from a SECOND `RewardsDistributor` instance. The
 * epoch runbook is explicit that it is "the same contract and
 * the same file format as the maker program ... Nothing about the two is interchangeable except the
 * code." So the code is shared and everything else is separate: a different address, a different
 * path, a different token, a different decimals.
 *
 * NO SECOND PARSER. The epoch-file format is identical, so re-implementing it for the lender program
 * would mean two validators that can drift apart — and the one that drifts is the one nobody is
 * looking at. `parseLenderEpochFile` IS `parseRewardEpochFile`.
 *
 * THE DISTRIBUTOR IS RESOLVED, THE TOKEN IS READ, AND NEITHER IS A CONSTANT ANY MORE. The address
 * used to be a module-level null constant and the scale used to be an 18 mirrored by hand from
 * the runbook; both constants are gone, names included — a grep for
 * them has to come back empty, so they are not quoted here either. The address comes from `config.ts` `resolveV2Address`
 * (`:123-130`): the registry's `rewardsDistributorLender` first, a validated
 * `NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR` override only while the registry is silent. The
 * decimals and symbol come from the distributor's own token.
 */
import type { Address } from "viem";

import { requireV2Address, resolveV2Address } from "./config";
import { lenderProgram, type RewardProgram, type RewardToken } from "./rewardPrograms";
import { claimReward, parseRewardEpochFile, readRewardClaim, rewardClaimProofValid,
  type RewardClaim, type RewardEpochFile } from "./rewardClaim";

export type { RewardClaim as LenderClaim, RewardEpochFile as LenderEpochFile } from "./rewardClaim";
export {
  parseRewardEpochFile as parseLenderEpochFile,
  rewardClaimProofValid as lenderClaimProofValid,
} from "./rewardClaim";
export { LENDER_EPOCH_BASE_PATH, lenderProgram } from "./rewardPrograms";

/**
 * The lender distributor: the registry's `rewardsDistributorLender`, else a valid override, else null.
 * See `rewardPrograms.ts` for the two addresses this must never be taken from (the generator's
 * exclusion registry, and the published epoch file).
 */
export function lenderDistributorAddress(): Address | null {
  return resolveV2Address("lenderRewardsDistributor").address;
}

export function requireLenderDistributorAddress(): Address {
  return requireV2Address("lenderRewardsDistributor");
}

/**
 * The lender program at its currently resolved address, denominated in a token the CALLER has
 * already read from chain.
 *
 * The token is a parameter rather than a read inside this function because the read is async and
 * every consumer is a React view that must render the unresolved state first. Passing `null` is
 * the honest starting state, not a placeholder to be defaulted away.
 */
export function lenderRewardProgram(token: RewardToken | null = null): RewardProgram {
  return lenderProgram(lenderDistributorAddress(), token);
}

/**
 * Reads a lender claim against the lender distributor. Rejects rather than guessing an address.
 *
 * `async` is load-bearing, not stylistic. `requireLenderDistributorAddress()` throws, and in a plain
 * function that throw happens SYNCHRONOUSLY, before any promise exists — so a caller writing
 * `readLenderClaim(...).catch(...)` never catches it. `async` turns it into a rejection, which is the
 * contract every other await-ed helper in this directory has. Caught by this module's own test.
 */
export async function readLenderClaim(file: RewardEpochFile, account: Address) {
  return readRewardClaim(requireLenderDistributorAddress(), file, account);
}

/** `async` for the same reason as {readLenderClaim}: the missing-address guard must REJECT. */
export async function claimLenderReward(
  wallet: Parameters<typeof claimReward>[0], account: Address, file: RewardEpochFile, entry: RewardClaim,
) {
  return claimReward(wallet, account, requireLenderDistributorAddress(), file, entry);
}
