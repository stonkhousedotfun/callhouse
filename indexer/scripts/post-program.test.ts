import { describe, expect, it } from "vitest";
import { PROGRAMS, distributorFor, outstandingLiability, requiredBalance } from "./post-maker-epoch.mjs";

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ROOT = "0x42758658626162126786767f92853840ef916b398e2e936d905f329436abfb44";
const MAKER = "0x1111111111111111111111111111111111111111";
const LENDER = "0x2222222222222222222222222222222222222222";
const LEGACY = "0x3333333333333333333333333333333333333333";

/** A chain stub: `posted` maps epoch -> [total, claimed]. Injected, so none of this needs an RPC. */
function reader(posted: Record<string, [bigint, bigint]>) {
  return {
    root: async (e: bigint) => (posted[String(e)] ? ROOT : ZERO),
    totalOf: async (e: bigint) => posted[String(e)]?.[0] ?? 0n,
    claimedAmount: async (e: bigint) => posted[String(e)]?.[1] ?? 0n,
  };
}

describe("--program selects the distributor", () => {
  it("maker keeps its legacy fallback so existing invocations are unchanged", () => {
    expect(distributorFor({ v2: { contracts: { rewardsDistributor: LEGACY } } }, "maker")).toBe(LEGACY);
  });

  it("the distributors block wins over the legacy key when both exist", () => {
    const registry = { v2: { protocolAddresses: { distributors: { maker: MAKER } }, contracts: { rewardsDistributor: LEGACY } } };
    expect(distributorFor(registry, "maker")).toBe(MAKER);
  });

  it("lender resolves from the distributors block", () => {
    expect(distributorFor({ v2: { protocolAddresses: { distributors: { lender: LENDER } } } }, "lender")).toBe(LENDER);
  });

  /**
   * The asymmetry is deliberate. There is no legacy lender address, so a fallback could only ever resolve to
   * the MAKER's distributor -- which would post lender rewards, denominated in an 18-decimal token, to the
   * contract paying 6-decimal USDG.
   */
  it("lender has NO fallback and refuses rather than guessing", () => {
    expect(() => distributorFor({ v2: { contracts: { rewardsDistributor: LEGACY } } }, "lender")).toThrow(/no lender distributor/);
  });

  it("an unknown program is refused", () => {
    expect(() => distributorFor({ v2: { protocolAddresses: { distributors: {} } } }, "user")).toThrow(/unknown --program/);
    expect(PROGRAMS).toEqual(["maker", "lender"]);
  });
});

describe("the funding floor includes what is still owed", () => {
  /**
   * CRITERION 6. Every epoch pays from ONE shared balance and an unclaimed entry never expires -- a defund
   * does not cancel it. So the floor is the new total PLUS the unpaid remainder of every posted epoch.
   */
  it("sums the unpaid remainder of previously posted epochs", async () => {
    const owed = await outstandingLiability(reader({ "2958": [100n, 40n], "2959": [50n, 50n] }), 2960n, 52n);
    expect(owed).toBe(60n); // 60 unpaid from 2958, 0 from 2959
  });

  it("ignores epochs that were never posted", async () => {
    const owed = await outstandingLiability(reader({}), 2960n, 52n);
    expect(owed).toBe(0n);
  });

  it("refuses a chain that reports more claimed than posted", async () => {
    await expect(outstandingLiability(reader({ "2959": [10n, 11n] }), 2960n, 52n)).rejects.toThrow(/claimed against a total/);
  });

  it("the lookback bounds the scan", async () => {
    const posted = { "2900": [1_000n, 0n] as [bigint, bigint], "2959": [7n, 0n] as [bigint, bigint] };
    expect(await outstandingLiability(reader(posted), 2960n, 1n)).toBe(7n);      // only 2959 is in range
    expect(await outstandingLiability(reader(posted), 2960n, 100n)).toBe(1_007n); // both
  });

  /**
   * PROVE IT BY BREAKING IT. `brokenRequired` is the check as it stood before this task: the new total alone.
   * The scenario is the one that actually loses money -- a balance that covers the new epoch exactly while an
   * older epoch is still owed 60. The old rule posts; the new rule refuses.
   */
  it("the old new-total-only rule would have posted against a balance that cannot pay", async () => {
    const owed = await outstandingLiability(reader({ "2958": [100n, 40n] }), 2960n, 52n);
    const planTotal = 500n;
    const balance = 500n;

    const brokenRequired = planTotal;                    // the removed term
    expect(balance < brokenRequired).toBe(false);        // RED: the old check waves this through

    const required = requiredBalance(planTotal, owed);   // the term restored
    expect(required).toBe(560n);
    expect(balance < required).toBe(true);               // GREEN: the new check refuses it
  });
});
