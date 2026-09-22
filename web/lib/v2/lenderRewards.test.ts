/**
 * The lender reward program, verified against the PINNED 18-decimal vector.
 *
 * WHAT CHANGED IN T-113, AND WHY IT MATTERED. The first version of this file (T-133) BUILT its own
 * two-leaf tree with viem and checked the proof against the root it had just computed. The header
 * argued that deriving beats pasting. That reasoning is right for `makerRewards.test.ts`, which pins
 * an INDEPENDENT OpenZeppelin vector — and wrong here, because the tree and the checker shared one
 * leaf formula, so the test could not detect a wrong leaf formula. It was a round trip agreeing with
 * itself: green no matter what the formula was.
 *
 * So this file now asserts against {PINNED_ROOT}, a LITERAL copied from the contracts repo — the same
 * artifact `RewardsDistributor.claim` verifies against on chain, and the same literal declared
 * independently at `indexer/scripts/lender-epoch.test.ts:16`. If our TypeScript mirror of the leaf
 * formula (`rewardClaim.ts`) ever drifts from `RewardsDistributor.sol:199-201`, the proofs in that
 * vector stop verifying and this goes red. That is the whole point: a user shown an unclaimable
 * reward is the failure, and only an externally-pinned root can catch it.
 *
 * The vector is vendored — see `fixtures/README.md` for its origin SHA and why it is a copy.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";

const readContract = vi.fn();
const simulateContract = vi.fn();
const waitForTransactionReceipt = vi.fn(async (..._args: unknown[]) => ({ status: "success", logs: [] }));

vi.mock("../chain", () => ({
  publicClient: {
    readContract: (...args: unknown[]) => readContract(...args),
    simulateContract: (...args: unknown[]) => simulateContract(...args),
    waitForTransactionReceipt: (...args: unknown[]) => waitForTransactionReceipt(...args),
  },
  robinhoodChain: { id: 4663 },
}));

import {
  claimLenderReward, lenderClaimProofValid, lenderDistributorAddress, lenderRewardProgram,
  parseLenderEpochFile, readLenderClaim, requireLenderDistributorAddress,
} from "./lenderRewards";
import { claimReward, readRewardClaim } from "./rewardClaim";
import {
  REWARD_AMOUNT_UNAVAILABLE, REWARDS_NOT_CONFIGURED, formatRewardAmount,
  formatRewardAmountWithSymbol, lenderProgram, makerProgram, resolveRewardToken, rewardAmountText,
  rewardProgramConfigured, type RewardToken,
} from "./rewardPrograms";

/**
 * THE PIN. Copied from `callhouse-contracts` `v8` `test/v2/fixtures/lender-epoch-2960.oz.json`
 * (landed by `c8fb46678dd9da992b0ab34c9e9b414050a7bc53`), NOT computed from the vendored file.
 * Writing it out is what makes the vendored copy checkable.
 */
const PINNED_ROOT = "0x42758658626162126786767f92853840ef916b398e2e936d905f329436abfb44";
const PINNED_EPOCH = 2960;

const vector = JSON.parse(readFileSync(fileURLToPath(
  new URL("./fixtures/lender-epoch-2960.oz.json", import.meta.url)), "utf8"));

const DISTRIBUTOR = "0x00000000000000000000000000000000000000d1" as Address;
const ZERO_ROOT = `0x${"0".repeat(64)}` as Hex;

/**
 * The two reward tokens as a CHAIN READ would return them, not as constants the source declares.
 * `rewardPrograms.ts` no longer contains an 18 or a 6 anywhere; these literals live here, in the
 * test, which is the only place a fixed expectation belongs.
 */
const LENDER_TOKEN: RewardToken = {
  address: "0x00000000000000000000000000000000000000f1" as Address, decimals: 18, symbol: "STONKHOUSE",
};
const USDG_TOKEN: RewardToken = {
  address: "0x00000000000000000000000000000000000000f6" as Address, decimals: 6, symbol: "USDG",
};
const LENDER = lenderProgram(DISTRIBUTOR, LENDER_TOKEN);

describe("the pinned 18-decimal vector", () => {
  it("the vendored copy is the pinned artifact, checked against the literal root", () => {
    // If someone edits the copy, this fails before any proof is examined.
    expect(vector.root.toLowerCase()).toBe(PINNED_ROOT);
    expect(vector.epoch).toBe(PINNED_EPOCH);
    expect(vector.decimals).toBe("18");
  });

  it("every published proof verifies against the PINNED root, not one we computed", () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    expect(file.root.toLowerCase()).toBe(PINNED_ROOT);
    expect(file.entries).toHaveLength(5);
    for (const entry of file.entries) expect(lenderClaimProofValid(file, entry), `index ${entry.index}`).toBe(true);
  });

  it("the vector's own tampered entry is rejected", () => {
    // The fixture ships a deliberately altered claim with `verifies: false`. Using the artifact's
    // own negative case means the negative is pinned too, not invented here.
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    expect(vector.tampered.verifies).toBe(false);
    expect(lenderClaimProofValid(file, vector.tampered)).toBe(false);
  });

  it("a wrong leaf formula would be caught: altering any field breaks the proof", () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    const entry = file.entries[0]!;
    expect(lenderClaimProofValid(file, { ...entry, amount: (BigInt(entry.amount) + 1n).toString() })).toBe(false);
    expect(lenderClaimProofValid(file, { ...entry, index: entry.index + 1 })).toBe(false);
    expect(lenderClaimProofValid({ ...file, epoch: PINNED_EPOCH + 1 }, entry)).toBe(false);
  });

  it("carries a ZERO-amount entry, and that is deliberate, not corrupt", () => {
    // RewardsDistributor.claim transfers only `if (amount != 0)` but still marks the index claimed,
    // so a wallet can be in a published epoch and be owed nothing. The parser must accept it.
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    const zero = file.entries.find((entry) => BigInt(entry.amount) === 0n);
    expect(zero, "the pinned vector's zero-amount entry").toBeDefined();
    expect(lenderClaimProofValid(file, zero!)).toBe(true);
  });

  it("amounts sum to the published total, at 18-decimal magnitudes", () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    expect(file.entries.reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(BigInt(file.total));
    expect(BigInt(file.total)).toBe(2601123456789012345678n);
  });
});

describe("decimals are a parameter, never a constant", () => {
  const maker = makerProgram(DISTRIBUTOR, USDG_TOKEN);

  it("the SAME base-unit amount renders differently for a 6- and an 18-decimal program", () => {
    // This is the bug the whole task exists for. One amount, two programs, two readings — and now
    // both scales arrive from a token read rather than from a constant in the source.
    const amount = 2_500_000_000_000_000_000_000n;
    expect(formatRewardAmount(amount, LENDER)).toBe("2500");
    expect(formatRewardAmount(amount, maker)).toBe("2500000000000000");
    expect(formatRewardAmount(amount, maker)).not.toBe(formatRewardAmount(amount, LENDER));
  });

  it("renders the pinned vector's amounts at 18 decimals, dust included", () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    const byIndex = (i: number) => BigInt(file.entries.find((e) => e.index === i)!.amount);
    expect(formatRewardAmount(byIndex(0), LENDER)).toBe("100");
    expect(formatRewardAmount(byIndex(2), LENDER)).toBe("1");
    expect(formatRewardAmount(byIndex(3), LENDER)).toBe("0");
    expect(formatRewardAmount(byIndex(4), LENDER)).toBe("0.123456789012345678");
  });

  it("keeps the maker/USDG behaviour unchanged", () => {
    expect(maker.token?.decimals).toBe(6);
    expect(maker.token?.symbol).toBe("USDG");
    expect(formatRewardAmount(1_750_000n, maker)).toBe("1.75");
    expect(formatRewardAmountWithSymbol(1_750_000n, maker)).toBe("1.75 USDG");
  });

  it("appends each program's own ticker, never a typed-in one", () => {
    expect(formatRewardAmountWithSymbol(10n ** 18n, LENDER)).toBe("1 STONKHOUSE");
  });

  it("RENDERS NOTHING NUMERIC when the token has not resolved — no 18, no 6, no zero", () => {
    // Spec test 10. The failure mode D6 moves us to is "no number", and the only way that is an
    // improvement on "wrong number" is if nothing downstream quietly supplies one.
    const unresolved = lenderProgram(DISTRIBUTOR, null);
    expect(formatRewardAmount(10n ** 18n, unresolved)).toBeNull();
    expect(formatRewardAmountWithSymbol(10n ** 18n, unresolved)).toBeNull();
    expect(rewardAmountText(10n ** 18n, unresolved)).toBe(REWARD_AMOUNT_UNAVAILABLE);
    expect(rewardAmountText(10n ** 18n, unresolved)).not.toMatch(/\d/);
    // ...and no wallet action is offered for it.
    expect(rewardProgramConfigured(unresolved)).toBe(false);
  });
});

describe("the reward token is read from the distributor, and a failed read is not a default", () => {
  const TOKEN = "0x00000000000000000000000000000000000000f1" as Address;

  it("asks the distributor which token it holds, then asks that token what it is", async () => {
    // Spec test 9's other half: the 18 that renders the pinned vector comes from decimals(), and
    // agreeing with the vector's own declared "18" is what makes the read checkable.
    readContract.mockReset();
    readContract.mockResolvedValueOnce(TOKEN).mockResolvedValueOnce(18).mockResolvedValueOnce("STONKHOUSE");
    const token = await resolveRewardToken(DISTRIBUTOR);
    expect(token).toEqual({ address: TOKEN, decimals: 18, symbol: "STONKHOUSE" });
    expect(String(token!.decimals)).toBe(vector.decimals);
    const [distributorCall] = readContract.mock.calls[0] as [{ address: Address; functionName: string }];
    expect(distributorCall.address).toBe(DISTRIBUTOR);
    expect(distributorCall.functionName).toBe("usdg");
  });

  it("a reverting usdg() resolves to no token rather than to a guess", async () => {
    readContract.mockReset();
    readContract.mockRejectedValueOnce(new Error("execution reverted"));
    expect(await resolveRewardToken(DISTRIBUTOR)).toBeNull();
  });

  it("a token with no decimals() resolves to no token", async () => {
    readContract.mockReset();
    readContract.mockResolvedValueOnce(TOKEN).mockRejectedValueOnce(new Error("execution reverted"));
    expect(await resolveRewardToken(DISTRIBUTOR)).toBeNull();
  });

  it("refuses an out-of-range decimals and an empty symbol instead of rendering them", async () => {
    readContract.mockReset();
    readContract.mockResolvedValueOnce(TOKEN).mockResolvedValueOnce(255).mockResolvedValueOnce("X");
    expect(await resolveRewardToken(DISTRIBUTOR)).toBeNull();
    readContract.mockReset();
    readContract.mockResolvedValueOnce(TOKEN).mockResolvedValueOnce(18).mockResolvedValueOnce("");
    expect(await resolveRewardToken(DISTRIBUTOR)).toBeNull();
  });

  it("refuses the zero address as a token", async () => {
    readContract.mockReset();
    readContract.mockResolvedValueOnce(`0x${"0".repeat(40)}` as Address);
    expect(await resolveRewardToken(DISTRIBUTOR)).toBeNull();
  });
});

describe("address handling is real EIP-55, not an identity function", () => {
  it("checksums a lowercase address to a hardcoded known-good literal", () => {
    // AC8 / the 2026-09-19 stubbed-viem incident: a stub whose `checksumAddress` was the IDENTITY
    // FUNCTION made assertions written against already-checksummed fixtures PASS. The only assertion
    // that catches that is one whose input is lowercase and whose expected value is mixed case, so
    // an identity function returns the input and fails.
    const lower = "0x70556baa315dd8d467ea452abcd7deebea073ff9";
    const CHECKSUMMED = "0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9";
    expect(getAddress(lower)).toBe(CHECKSUMMED);
    expect(CHECKSUMMED).not.toBe(lower); // the literal must actually differ, or the test is vacuous
  });

  it("normalises entry accounts, and the pinned vector cannot prove that on its own", () => {
    // The vector's accounts are 0x1111…, 0x2222… — all digits, so their checksum equals their
    // lowercase form and they would pass under an identity function too. Stated so nobody reads the
    // vector's green as evidence of checksumming.
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    for (const entry of file.entries) expect(entry.account).toBe(getAddress(entry.account));
  });
});

describe("lender program configuration", () => {
  it("has its own path and id, and no literal pins its status", () => {
    expect(LENDER.epochBasePath).not.toContain("maker");
    expect(LENDER.id).toBe("lender");
    // Spec test 7 / AC9: live is DERIVED from an address plus a resolved token. Each half alone
    // leaves it planned, which is what a status literal could not have expressed.
    expect(LENDER.status).toBe("live");
    expect(lenderProgram(DISTRIBUTOR, null).status).toBe("planned");
    expect(lenderProgram(null, LENDER_TOKEN).status).toBe("planned");
    expect(lenderProgram(null, null).status).toBe("planned");
  });

  it("exposes no wallet action while unconfigured, and says so in those words", () => {
    // No NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR is set in this environment, so the resolver
    // returns null — the program is unconfigured for the same reason production would be.
    expect(lenderDistributorAddress()).toBeNull();
    const unconfigured = lenderRewardProgram();
    expect(rewardProgramConfigured(unconfigured)).toBe(false);
    expect(unconfigured.notConfiguredNotice).toContain(REWARDS_NOT_CONFIGURED);
    expect(unconfigured.notConfiguredNotice).toContain("permissionless");
  });

  it("a program is configured only when it is live AND addressed AND denominated", () => {
    expect(rewardProgramConfigured(lenderProgram(null, LENDER_TOKEN))).toBe(false);
    expect(rewardProgramConfigured(lenderProgram(DISTRIBUTOR, null))).toBe(false);
    expect(rewardProgramConfigured(LENDER)).toBe(true);
    // A hand-forced "live" with a missing half is still refused, so the two cannot drift apart.
    expect(rewardProgramConfigured({ ...LENDER, status: "live", token: null })).toBe(false);
    expect(rewardProgramConfigured({ ...LENDER, status: "live", distributor: null })).toBe(false);
  });

  it("keeps the maker program's not-configured sentence byte-identical to what shipped", () => {
    // T-133 criterion 4. Nothing in this package can render-test it, so it is pinned as a string.
    expect(makerProgram(null).notConfiguredNotice)
      .toBe("Reward claims will open after the RewardsDistributor is deployed.");
  });

  it("refuses every wallet action with a reason, and reads nothing from the chain to find an address", async () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    readContract.mockReset();
    expect(() => requireLenderDistributorAddress()).toThrow(/not deployed/);
    expect(() => requireLenderDistributorAddress()).toThrow(/NEXT_PUBLIC_V2_LENDER_REWARDS_DISTRIBUTOR/);
    await expect(readLenderClaim(file, file.entries[0]!.account)).rejects.toThrow(/not deployed/);
    await expect(claimLenderReward({} as never, file.entries[0]!.account, file, file.entries[0]!))
      .rejects.toThrow(/not deployed/);
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe("the published file's refusals survive generalisation", () => {
  const mutate = (fn: (copy: Record<string, unknown>) => void) => {
    const copy = JSON.parse(JSON.stringify(vector));
    fn(copy);
    return copy;
  };

  it("rejects a wrong epoch, a wrong total, duplicate accounts, sparse indices and a bad root", () => {
    expect(() => parseLenderEpochFile(vector, PINNED_EPOCH + 1)).toThrow();
    expect(() => parseLenderEpochFile(mutate((c) => { c.total = "1"; }), PINNED_EPOCH)).toThrow();
    expect(() => parseLenderEpochFile(mutate((c) => {
      (c.entries as { account: string }[])[1]!.account = (c.entries as { account: string }[])[0]!.account;
    }), PINNED_EPOCH)).toThrow();
    expect(() => parseLenderEpochFile(mutate((c) => {
      (c.entries as { index: number }[])[2]!.index = 9;
    }), PINNED_EPOCH)).toThrow();
    expect(() => parseLenderEpochFile(mutate((c) => { c.root = "0xnotaroot"; }), PINNED_EPOCH)).toThrow();
  });

  it("rejects a fractional, signed or non-string amount rather than coercing it", () => {
    for (const bad of ["1.5", "-1", "1e18", ""] as const) {
      expect(() => parseLenderEpochFile(mutate((c) => {
        (c.entries as { amount: unknown }[])[0]!.amount = bad;
      }), PINNED_EPOCH), bad).toThrow();
    }
    expect(() => parseLenderEpochFile(mutate((c) => {
      (c.entries as { amount: unknown }[])[0]!.amount = 100;
    }), PINNED_EPOCH)).toThrow();
  });

  it("rejects a malformed proof element", () => {
    expect(() => parseLenderEpochFile(mutate((c) => {
      (c.entries as { proof: string[] }[])[0]!.proof[0] = "0xshort";
    }), PINNED_EPOCH)).toThrow();
  });
});

describe("the security properties, each one exercised", () => {
  it("PROPERTY 1 — an on-chain root that differs from the file's is refused", async () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    readContract.mockReset();
    readContract.mockResolvedValueOnce(ZERO_ROOT).mockResolvedValueOnce(false);
    await expect(readRewardClaim(DISTRIBUTOR, file, file.entries[0]!.account))
      .rejects.toThrow(/do not match the on-chain root/);
  });

  it("PROPERTY 2 — isClaimed is re-read live, so a stale file cannot prompt a wallet write", async () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    readContract.mockReset();
    simulateContract.mockReset();
    readContract.mockResolvedValueOnce(PINNED_ROOT).mockResolvedValueOnce(true);
    const wallet = { getChainId: vi.fn(async () => 4663), writeContract: vi.fn() };
    await expect(claimReward(wallet as never, file.entries[0]!.account, DISTRIBUTOR, file, file.entries[0]!))
      .rejects.toThrow(/no longer claimable/);
    expect(simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("PROPERTY 3 — a wallet cannot claim another wallet's entry, and stops before the chain", async () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    readContract.mockReset();
    const wallet = { getChainId: vi.fn(async () => 4663), writeContract: vi.fn() };
    await expect(claimReward(wallet as never, file.entries[1]!.account, DISTRIBUTOR, file, file.entries[0]!))
      .rejects.toThrow(/does not belong to your wallet/);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("passes the 18-decimal amount through to the simulated call unchanged", async () => {
    const file = parseLenderEpochFile(vector, PINNED_EPOCH);
    const entry = file.entries[1]!; // 2500 whole tokens
    readContract.mockReset();
    simulateContract.mockReset();
    readContract.mockResolvedValueOnce(PINNED_ROOT).mockResolvedValueOnce(false);
    simulateContract.mockResolvedValueOnce({ request: {} });
    const wallet = { getChainId: vi.fn(async () => 4663), writeContract: vi.fn(async () => "0xhash") };
    await claimReward(wallet as never, entry.account, DISTRIBUTOR, file, entry);
    const args = simulateContract.mock.calls[0]![0] as { args: unknown[] };
    expect(args.args[3]).toBe(BigInt(entry.amount));
    expect(args.args[3]).toBe(2_500_000_000_000_000_000_000n);
  });
});
