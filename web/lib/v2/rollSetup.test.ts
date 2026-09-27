import { describe, expect, it } from "vitest";
import { nextRollStep, rollProgressFromChain, rollStatusFromChain, ROLL_STEPS, type RollProgress, type RollStep,
  validateRollStrategy } from "./rollSetup";

describe("resumable auto-roll setup", () => {
  it("continues from the first unconfirmed permission", () => {
    expect(nextRollStep({ payout: false, operator: false, bookOperator: false, delegate: false, strategy: false })).toBe("payout");
    expect(nextRollStep({ payout: true, operator: false, bookOperator: false, delegate: false, strategy: false })).toBe("operator");
    expect(nextRollStep({ payout: true, operator: true, bookOperator: false, delegate: false, strategy: false })).toBe("bookOperator");
    expect(nextRollStep({ payout: true, operator: true, bookOperator: true, delegate: false, strategy: false })).toBe("delegate");
    expect(nextRollStep({ payout: true, operator: true, bookOperator: true, delegate: true, strategy: false })).toBe("strategy");
    expect(nextRollStep({ payout: true, operator: true, bookOperator: true, delegate: true, strategy: true })).toBeNull();
  });

  it("does not reuse delegation from a previously connected wallet", () => {
    const firstWallet = rollProgressFromChain({ payoutToLedger: true, rollerOperator: true, orderBookOperator: true, delegate: true });
    expect(nextRollStep(firstWallet)).toBe("strategy");
    const switchedWallet = rollProgressFromChain({ payoutToLedger: true, rollerOperator: true, orderBookOperator: true, delegate: false });
    expect(nextRollStep(switchedWallet)).toBe("delegate");
  });

  it("rejects on-chain invalid bounds before opening the wallet", () => {
    const valid = { smartPricing: true, otmBps: 500, askBps: 90, minAskBps: 50, maxAskBps: 180, maxUnits: "100" };
    expect(validateRollStrategy(valid)).toBeNull();
    expect(validateRollStrategy({ ...valid, otmBps: 2_501 })).toMatch(/1% and 25%/);
    expect(validateRollStrategy({ ...valid, minAskBps: 91 })).toMatch(/minimum/);
    // AutoRoller.MIN_ASK_BPS = 50: 49 is refused, both as an ask and as a smart-price minimum.
    expect(validateRollStrategy({ ...valid, askBps: 49, minAskBps: 49 })).toMatch(/Starting ask/);
    expect(validateRollStrategy({ ...valid, minAskBps: 49 })).toMatch(/Smart-price bounds/);
    expect(validateRollStrategy({ ...valid, askBps: 50, minAskBps: 50, maxAskBps: 50 }, 1_000_100n)).toMatch(/No 0.0001 USDG price/);
    expect(validateRollStrategy({ ...valid, smartPricing: false, minAskBps: 0, maxAskBps: 0 }, 1_000_100n)).toBeNull();
    expect(validateRollStrategy({ ...valid, maxUnits: "18446744073709551616" })).toMatch(/size/);
  });
});

/*
 * AutoRoller.roll requires `clearinghouse.isOperator(writer, roller) && clearinghouse.isOperator(writer, orderBook)`
 * and the delegate, or it reverts NotAuthorized (contracts AutoRoller.sol). The wizard never asked for the OrderBook flag,
 * so a page-only setup showed Active while every keeper roll was refused.
 */
describe("the auto-roll setup grants the OrderBook operator flag, and Active needs every permission", () => {
  /** The wallet prompts the wizard would open, in order, each one confirmed. */
  const promptsFor = (reads: Parameters<typeof rollProgressFromChain>[0]): RollStep[] => {
    const progress: RollProgress = rollProgressFromChain(reads);
    const seen: RollStep[] = [];
    for (let key = nextRollStep(progress); key !== null; key = nextRollStep(progress)) { seen.push(key); progress[key] = true; }
    return seen;
  };

  it("a fresh writer (both operator flags false) is asked for the OrderBook operator flag as its own step", () => {
    expect(ROLL_STEPS.map((step) => step.key)).toEqual(["payout", "operator", "bookOperator", "delegate", "strategy"]);
    expect(promptsFor({ payoutToLedger: false, rollerOperator: false, orderBookOperator: false, delegate: false }))
      .toEqual(["payout", "operator", "bookOperator", "delegate", "strategy"]);
  });

  it("a writer who already has the OrderBook flag (from a manual ask) skips that step", () => {
    expect(promptsFor({ payoutToLedger: true, rollerOperator: false, orderBookOperator: true, delegate: false }))
      .toEqual(["operator", "delegate", "strategy"]);
  });

  it("a roller-only writer is not Active; both flags + delegate + strategy is", () => {
    const rollerOnly = { strategyActive: true, rollerOperator: true, orderBookOperator: false, delegate: true };
    expect(rollStatusFromChain(rollerOnly)).toBe("incomplete");
    expect(rollStatusFromChain({ ...rollerOnly, orderBookOperator: true })).toBe("active");
    expect(rollStatusFromChain({ ...rollerOnly, orderBookOperator: true, rollerOperator: false })).toBe("incomplete");
    expect(rollStatusFromChain({ ...rollerOnly, orderBookOperator: true, delegate: false })).toBe("incomplete");
    expect(rollStatusFromChain({ ...rollerOnly, orderBookOperator: true, strategyActive: false })).toBe("off");
  });
});
