import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import type { RewardEpochProjection } from "../../../lib/v2/rewardEpochFiles.generated";
import { mergeRewardClaims } from "./rewards";

const ACCOUNT = getAddress("0x0000000000000000000000000000000000000011");
const OTHER = getAddress("0x0000000000000000000000000000000000000022");
const FIRST = getAddress("0x0000000000000000000000000000000000000099");
const SECOND = getAddress("0x00000000000000000000000000000000000000aa");
const ROOT_10 = `0x${"a".repeat(64)}`;
const ROOT_9 = `0x${"b".repeat(64)}`;
const MISMATCH = `0x${"c".repeat(64)}`;
const ROOT_8 = `0x${"d".repeat(64)}`;
const TX = `0x${"1".repeat(64)}` as const;

describe("reward claim projection", () => {
  it("merges event claims with only root-matched committed leaves", () => {
    const files = [
      { program: "maker", epoch: 10, root: ROOT_10, total: "20",
        entries: [{ index: 0, account: ACCOUNT, amount: "8" }] },
      { program: "maker", epoch: 9, root: ROOT_9, total: "10",
        entries: [{ index: 1, account: ACCOUNT, amount: "7" }] },
      { program: "maker", epoch: 8, root: ROOT_8, total: "6",
        entries: [{ index: 2, account: ACCOUNT, amount: "6" }] },
    ] satisfies readonly RewardEpochProjection[];
    const items = mergeRewardClaims(
      ACCOUNT,
      [{ program: "maker", address: FIRST }, { program: "maker", address: SECOND }],
      [
        { distributor: FIRST, epoch: 10n, root: ROOT_10, total: 20n },
        { distributor: SECOND, epoch: 10n, root: MISMATCH, total: 20n },
        { distributor: FIRST, epoch: 9n, root: ROOT_9, total: 10n },
        { distributor: SECOND, epoch: 9n, root: MISMATCH, total: 10n },
        { distributor: FIRST, epoch: 8n, root: ROOT_8, total: 6n },
      ],
      [
        { distributor: FIRST, epoch: 10n, leafIndex: 0n, account: ACCOUNT, amount: 8n, tx: TX },
        { distributor: SECOND, epoch: 10n, leafIndex: 0n, account: ACCOUNT, amount: 9n, tx: TX },
        { distributor: FIRST, epoch: 9n, leafIndex: 1n, account: OTHER, amount: 7n, tx: TX },
      ],
      files,
    );

    expect(items).toEqual([
      { program: "maker", distributor: FIRST, epochId: 10, index: 0, amount: 8n, claimed: true, tx: TX },
      { program: "maker", distributor: SECOND, epochId: 10, index: 0, amount: 9n, claimed: true, tx: TX },
      { program: "maker", distributor: FIRST, epochId: 8, index: 2, amount: 6n, claimed: false, tx: null },
    ]);
    expect(items.every((item) => !("proof" in item))).toBe(true);
  });
});
