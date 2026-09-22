/**
 * Merkle reward programs. One shape, two instances: makers paid in USDG and Earn-vault lenders paid
 * in the lender reward token.
 *
 * WHY THIS FILE EXISTS. `RewardsDistributor` is token-agnostic — its getter is still named `usdg()`
 * but it holds whatever `IERC20` it was constructed with (`contracts/src/v2/mm/RewardsDistributor.sol:45,61-66`),
 * and P8-05 deploys a SECOND instance holding the lender token. So the contract needed nothing. What
 * needed fixing was the UI: `MakersPage.tsx` formatted every amount with a literal `6` and appended
 * the literal string "USDG", which for an 18-decimal token does not error — it renders a number
 * roughly a trillion times too large, in the wrong unit, next to a button that spends it. A claim
 * screen that is wrong by 1e12 and still looks like a claim screen is the failure this
 * parameterisation removes.
 *
 * DECIMALS AND SYMBOL ARE READ FROM CHAIN AND LITERALS NOWHERE (D6, owner directive 2026-09-20).
 * They used to be fields filled from constants: an 18 mirrored out of
 * `ops/runbooks/lender-rewards-epoch.md:3` and a token symbol typed by hand. Both constants are
 * deleted, and their NAMES are deliberately not quoted anywhere in this tree either — AC7 greps
 * for them and has to come back empty. The guard
 * that made an unconfirmed constant safe was `LENDER_PROGRAM.status = "planned"`, so shipping the
 * program while keeping the constant would have shipped the risk with its guard removed. Deleting
 * the CONSTANT removes both: {resolveRewardToken} asks the distributor which token it holds and
 * asks that token for its own `decimals()` and `symbol()`.
 *
 * NEVER DEFAULT THE DECIMALS. A read that has not returned is not a number. When {RewardProgram.token}
 * is null the amount renders as {REWARD_AMOUNT_UNAVAILABLE} and no claim action is exposed; a
 * fallback of 18 or 6 would be the same trillion-fold bug with a longer fuse.
 */
import { formatUnits, type Address, type PublicClient } from "viem";

import { rewardsDistributorAbi } from "../abi/v2/rewardsDistributor";
import { erc20Abi } from "../abi/erc20";
import { publicClient } from "../chain";
import { MAX_RENDERABLE_DECIMALS } from "./api-schema";

export type RewardProgramStatus = "planned" | "live";

/** A program's reward token as the chain describes it. Never assembled from a constant. */
export type RewardToken = {
  address: Address;
  /** `decimals()` off the token itself, bounded by the same ceiling the API schema enforces. */
  decimals: number;
  /** `symbol()` off the token itself. */
  symbol: string;
};

export type RewardProgram = {
  /** Stable id, used in query keys so two programs never share a cache entry. */
  id: "maker" | "lender";
  /** Human label for headings and notices, e.g. "maker" in "Confirm maker reward". */
  label: string;
  /** Base path the epoch file is fetched from. `${epochBasePath}/${epoch}.json`. */
  epochBasePath: string;
  /**
   * The reward token, resolved from `distributor.usdg()`. NULL UNTIL THE READ RETURNS, and null
   * again if it fails — which is a rendering state, not a default. Nothing downstream may
   * substitute a decimals value for it.
   */
  token: RewardToken | null;
  /** Null until this program's own distributor address resolves. */
  distributor: Address | null;
  /**
   * DERIVED, never a literal. `live` means this program has both an address to claim from and a
   * token to denominate the claim in. The previous `status: "planned"` literal on the lender
   * program is what AC9 removes: a literal can disagree with the address beside it, a derivation
   * cannot.
   */
  status: RewardProgramStatus;
  /**
   * What the view says when the program is not configured.
   *
   * IT IS A FIELD BECAUSE THE TWO PROGRAMS MUST DIFFER HERE. T-113 requires the lender view to say
   * "Rewards are not configured"; T-133 requires the maker path to render byte-identically to what
   * shipped before, and what shipped before was a different sentence. Hardcoding either one would
   * quietly break the other criterion, and the maker regression would be invisible — there is no
   * render test in this package that could catch it.
   */
  notConfiguredNotice: string;
};

/** Rendered in place of an amount whose token has not resolved. Never a number. */
export const REWARD_AMOUNT_UNAVAILABLE = "Unavailable";

/**
 * Format a reward amount in ITS OWN program's decimals, or NULL if they are not known.
 *
 * The one-line function this whole task exists for. It is a named export rather than an inline
 * `formatUnits(amount, 6)` at a call site because a decimals bug is invisible at the call site: the
 * wrong scale does not throw, it renders a plausible number. Pulling it out means a test can assert
 * that the SAME base-unit amount renders differently for a 6-decimal and an 18-decimal program,
 * which is the only assertion that actually catches the bug.
 *
 * It returns `string | null` rather than falling back so that a caller cannot render a number it
 * has no scale for. The null is the point.
 */
export function formatRewardAmount(amount: bigint, program: RewardProgram): string | null {
  return program.token === null ? null : formatUnits(amount, program.token.decimals);
}

/** "12.5 STONKHOUSE" — amount and ticker together, so neither is typed at a call site. */
export function formatRewardAmountWithSymbol(amount: bigint, program: RewardProgram): string | null {
  const formatted = formatRewardAmount(amount, program);
  return formatted === null || program.token === null ? null : `${formatted} ${program.token.symbol}`;
}

/** {REWARD_AMOUNT_UNAVAILABLE} when the token has not resolved, so a view can render it directly. */
export function rewardAmountText(amount: bigint, program: RewardProgram): string {
  return formatRewardAmountWithSymbol(amount, program) ?? REWARD_AMOUNT_UNAVAILABLE;
}

/**
 * No wallet action is exposed unless the program is live AND has a distributor AND has a token.
 *
 * The token clause is not a compliance gate. A claim screen with no resolved decimals cannot state
 * what it is about to spend, so it does not offer the button.
 */
export function rewardProgramConfigured(program: RewardProgram): boolean {
  return program.status === "live" && program.distributor !== null && program.token !== null;
}

/** AC9 copy, in one place so the page and its test cannot disagree about the wording. */
export const REWARDS_NOT_CONFIGURED = "Rewards are not configured";

/** Each program's own published path. Neither is the other's. */
export const MAKER_EPOCH_BASE_PATH = "/maker-epochs";
export const LENDER_EPOCH_BASE_PATH = "/lender-epochs";

/**
 * Ask a distributor which token it pays in, then ask that token what it is.
 *
 * `usdg()` is the getter's name, not the token's identity — the distributor is token-agnostic and
 * holds whatever it was constructed with, so for the lender instance `usdg()` IS the lender reward
 * token. The helper is named for what it does.
 *
 * RETURNS NULL RATHER THAN THROWING OR DEFAULTING. A reverting `usdg()`, a token with no
 * `decimals()`, an out-of-range decimals value and an empty symbol all land in the same place: the
 * token is not known, the amount renders as unavailable, and no claim action appears.
 */
export async function resolveRewardToken(
  distributor: Address, client: PublicClient = publicClient,
): Promise<RewardToken | null> {
  try {
    const token = await client.readContract({
      address: distributor, abi: rewardsDistributorAbi, functionName: "usdg",
    }) as Address;
    if (!token || /^0x0{40}$/i.test(token)) return null;
    const [decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
    ]);
    const scale = Number(decimals);
    if (!Number.isSafeInteger(scale) || scale < 0 || scale > MAX_RENDERABLE_DECIMALS) return null;
    if (typeof symbol !== "string" || symbol.length === 0) return null;
    return { address: token, decimals: scale, symbol };
  } catch {
    return null;
  }
}

function programStatus(distributor: Address | null, token: RewardToken | null): RewardProgramStatus {
  return distributor !== null && token !== null ? "live" : "planned";
}

/**
 * The same program with its token filled in, and its status re-derived.
 *
 * Views resolve the token asynchronously, so they need a way to fold the answer back in WITHOUT
 * re-deriving `status` by hand at each call site — a spread that set `token` and left `status`
 * alone would produce a program that is denominated and still says `planned`, which is the drift
 * a derived status exists to prevent.
 */
export function withRewardToken(program: RewardProgram, token: RewardToken | null): RewardProgram {
  return { ...program, token, status: programStatus(program.distributor, token) };
}

/** One query key for the token read, so two views of the same program share one fetch. */
export function rewardTokenQueryKey(program: RewardProgram): readonly unknown[] {
  return ["reward-token", program.id, program.distributor];
}

/**
 * The maker program. `distributor` is supplied by the caller from
 * `V2_DEPLOYMENT.contracts.rewardsDistributor`, which is the MAKER instance — the generated
 * registry's only distributor key today. `token` is supplied by the caller from
 * {resolveRewardToken} against that same distributor; it is NOT `USDG, 6` by assumption, because
 * assuming it is what this deliverable removes.
 */
export function makerProgram(distributor: Address | null, token: RewardToken | null = null): RewardProgram {
  return {
    id: "maker",
    label: "maker",
    epochBasePath: MAKER_EPOCH_BASE_PATH,
    token,
    distributor,
    status: programStatus(distributor, token),
    // VERBATIM the sentence the maker page rendered before T-133 extracted this component. Do not
    // "improve" it — T-133 acceptance criterion 4 is that the maker path is byte-identical.
    notConfiguredNotice: "Reward claims will open after the RewardsDistributor is deployed.",
  };
}

/**
 * The lender program. A FUNCTION, symmetrical with {makerProgram}, because its distributor is no
 * longer a module-level `null` constant.
 *
 * WHERE THE ADDRESS COMES FROM, and the two places it must never come from:
 *   - `lenderRewards.ts` resolves it through `config.ts` `resolveV2Address`, which under design B
 *     means a validated `NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR` override. No registry key is
 *     added for it (rule 2, 02-interfaces.md:584-590).
 *   - NOT `ops/markets/tier1.json` `v2.protocolAddresses.distributors.lender`. That near-miss is
 *     the generator's EXCLUSION registry of protocol-owned wallets to drop from a reward
 *     computation, is not exposed to the web app at all, and wiring it up would point the claim
 *     screen at the wrong contract.
 *   - NEVER the published epoch JSON. That file is unauthenticated operator data; a file naming the
 *     contract it should be claimed from is how a wallet gets pointed at an attacker's address.
 */
export function lenderProgram(distributor: Address | null, token: RewardToken | null = null): RewardProgram {
  return {
    id: "lender",
    label: "lender",
    epochBasePath: LENDER_EPOCH_BASE_PATH,
    token,
    distributor,
    status: programStatus(distributor, token),
    notConfiguredNotice: `${REWARDS_NOT_CONFIGURED}. Claiming is permissionless once it is — the contract checks your Merkle proof, so this page is a convenience and never an eligibility gate.`,
  };
}
