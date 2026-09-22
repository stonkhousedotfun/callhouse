import { describe, expect, it } from "vitest";
import { nextRollStep, rollProgressFromChain, validateRollStrategy } from "./rollSetup";

describe("resumable auto-roll setup", () => {
  it("continues from the first unconfirmed permission", () => {
    expect(nextRollStep({ payout: false, operator: false, delegate: false, strategy: false })).toBe("payout");
    expect(nextRollStep({ payout: true, operator: false, delegate: false, strategy: false })).toBe("operator");
    expect(nextRollStep({ payout: true, operator: true, delegate: false, strategy: false })).toBe("delegate");
    expect(nextRollStep({ payout: true, operator: true, delegate: true, strategy: false })).toBe("strategy");
    expect(nextRollStep({ payout: true, operator: true, delegate: true, strategy: true })).toBeNull();
  });

  it("does not reuse delegation from a previously connected wallet", () => {
    const firstWallet = rollProgressFromChain({ payoutToLedger: true, rollerOperator: true, delegate: true });
    expect(nextRollStep(firstWallet)).toBe("strategy");
    const switchedWallet = rollProgressFromChain({ payoutToLedger: true, rollerOperator: true, delegate: false });
    expect(nextRollStep(switchedWallet)).toBe("delegate");
  });

  it("rejects on-chain invalid bounds before opening the wallet", () => {
    const valid = { smartPricing: true, otmBps: 500, askBps: 90, minAskBps: 45, maxAskBps: 180, maxUnits: "100" };
    expect(validateRollStrategy(valid)).toBeNull();
    expect(validateRollStrategy({ ...valid, otmBps: 2_501 })).toMatch(/1% and 25%/);
    expect(validateRollStrategy({ ...valid, minAskBps: 91 })).toMatch(/minimum/);
    expect(validateRollStrategy({ ...valid, askBps: 4, minAskBps: 4 })).toMatch(/Starting ask/);
    expect(validateRollStrategy({ ...valid, askBps: 5, minAskBps: 5, maxAskBps: 5 }, 1_000_100n)).toMatch(/No 0.0001 USDG price/);
    expect(validateRollStrategy({ ...valid, smartPricing: false, minAskBps: 0, maxAskBps: 0 }, 1_000_100n)).toBeNull();
    expect(validateRollStrategy({ ...valid, maxUnits: "18446744073709551616" })).toMatch(/size/);
  });
});
