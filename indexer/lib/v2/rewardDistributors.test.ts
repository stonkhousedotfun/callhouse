import { describe, expect, it } from "vitest";

import { parseRewardDistributors } from "./rewardDistributors";

const FIRST = "0x0000000000000000000000000000000000000099" as const;
const SECOND = "0x00000000000000000000000000000000000000aa" as const;

describe("RewardsDistributor configuration", () => {
  it("keeps the singular deployment setting as a maker fallback", () => {
    expect(parseRewardDistributors(undefined, FIRST)).toEqual([{ program: "maker", address: FIRST }]);
  });

  it("accepts replacement instances and open programme strings", () => {
    expect(parseRewardDistributors(JSON.stringify([
      { program: "maker", address: FIRST },
      { program: "future-lenders", address: SECOND },
    ]))).toEqual([
      { program: "maker", address: FIRST },
      { program: "future-lenders", address: "0x00000000000000000000000000000000000000AA" },
    ]);
  });

  it("rejects duplicate instances and disagreement with the legacy maker setting", () => {
    expect(() => parseRewardDistributors(JSON.stringify([
      { program: "maker", address: FIRST },
      { program: "replacement", address: FIRST },
    ]))).toThrow("repeats");
    expect(() => parseRewardDistributors(JSON.stringify([
      { program: "maker", address: SECOND },
    ]), FIRST)).toThrow("must match a maker entry");
  });
});
