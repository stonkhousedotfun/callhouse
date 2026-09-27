/**
 * The lender program's "not configured" notice is short and plain (copy rules): no Merkle
 * or eligibility-gate jargon, still true (claims are permissionless once the distributor is set), and it still carries
 * the shared REWARDS_NOT_CONFIGURED phrase the lender rewards page and its tests look for. The maker sentence is
 * pinned byte-identical elsewhere (lib/v2/lenderRewards.test.ts) and is not touched here.
 */
import { describe, expect, it } from "vitest";

import { REWARDS_NOT_CONFIGURED, lenderProgram } from "./rewardPrograms";

describe("lender not-configured notice", () => {
  const notice = lenderProgram(null).notConfiguredNotice;

  it("keeps the shared phrase and says claims need no permission", () => {
    expect(notice).toContain(REWARDS_NOT_CONFIGURED);
    expect(notice).toContain("permissionless");
  });

  it("is one short line with no proof or gate jargon", () => {
    expect(notice.length).toBeLessThanOrEqual(130);
    expect(notice).not.toMatch(/Merkle|eligibility gate|convenience/i);
  });
});
