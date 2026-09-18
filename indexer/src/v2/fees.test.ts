import { describe, expect, it } from "vitest";
import { effectiveFees, feeStateColumns, feeStateFromRow, feesEqual, scheduleFees,
  scheduledFeeColumns, type OrderBookFees } from "../../lib/v2/fees";

const initial: OrderBookFees = {
  premiumFeeBps: 500, resaleFeeBps: 0, takerFeeFlat: 100_000n,
  takerFeeCapBps: 1_000, makerRebateBps: 100,
};
const first: OrderBookFees = { ...initial, premiumFeeBps: 300, takerFeeFlat: 50_000n };
const second: OrderBookFees = { ...initial, premiumFeeBps: 200, makerRebateBps: 200 };
const day = 86_400n;

describe("delayed OrderBook fees", () => {
  it("retains constructor fees until the exact effective block timestamp, including when no log fires", () => {
    const state = scheduleFees({ active: initial, pending: null }, first, 100n + day, 100n);
    expect(effectiveFees(state, 100n + day - 1n)).toEqual(initial);
    expect(effectiveFees(state, 100n + day)).toEqual(first);
    expect(effectiveFees(state, 100n + day + 1n)).toEqual(first);
  });

  it("replaces a not-yet-due schedule and restarts the delay", () => {
    const a = scheduleFees({ active: initial, pending: null }, first, 100n + day, 100n);
    const b = scheduleFees(a, second, 200n + day, 200n);
    expect(b.active).toEqual(initial);
    expect(effectiveFees(b, 100n + day)).toEqual(initial);
    expect(effectiveFees(b, 200n + day)).toEqual(second);
  });

  it("promotes a due schedule before scheduling another change", () => {
    const a = scheduleFees({ active: initial, pending: null }, first, 100n + day, 100n);
    const b = scheduleFees(a, second, 100n + day * 2n, 100n + day);
    expect(b.active).toEqual(first);
    expect(effectiveFees(b, 100n + day)).toEqual(first);
    expect(effectiveFees(b, 100n + day * 2n)).toEqual(second);
  });

  it("models cancellation as a scheduled return to current fees, preserving the raw pending event", () => {
    const a = scheduleFees({ active: initial, pending: null }, first, 100n + day, 100n);
    const cancelled = scheduleFees(a, initial, 200n + day, 200n);
    expect(cancelled.pending?.fees).toEqual(initial);
    expect(feesEqual(effectiveFees(cancelled, 200n), cancelled.pending!.fees)).toBe(true);
    expect(effectiveFees(cancelled, 200n + day)).toEqual(initial);
  });

  it("round-trips the stored fields and rejects an incomplete pending tuple", () => {
    const state = scheduleFees({ active: initial, pending: null }, first, 100n + day, 100n);
    const columns = feeStateColumns(state);
    expect(feeStateFromRow(columns, second)).toEqual(state);
    expect(feeStateFromRow(null, initial)).toEqual({ active: initial, pending: null });
    expect(() => feeStateFromRow({ ...columns, pendingTakerFeeFlat: null }, second))
      .toThrow("incomplete scheduled OrderBook fees");
  });

  it("does not accept a due-at-or-before-schedule timestamp", () => {
    expect(() => scheduleFees({ active: initial, pending: null }, first, 100n, 100n)).toThrow(RangeError);
  });

  it("reduces decoded FeeParamsScheduled logs into a reorg-safe stored state", () => {
    const log = { premiumFeeBps: 300, resaleFeeBps: 0, takerFeeFlat: 50_000,
      takerFeeCapBps: 1_000, makerRebateBps: 100 };
    const scheduled = scheduledFeeColumns(null, initial, log, 100n + day, 100n);
    expect(scheduled.premiumFeeBps).toBe(initial.premiumFeeBps);
    expect(scheduled.pendingPremiumFeeBps).toBe(300);
    expect(scheduled.pendingTakerFeeFlat).toBe(50_000n);
    expect(scheduled.pendingEffectiveAt).toBe(100n + day);

    const replacement = scheduledFeeColumns(scheduled, initial,
      { ...log, premiumFeeBps: 200n }, 200n + day, 200n);
    expect(replacement.premiumFeeBps).toBe(initial.premiumFeeBps);
    expect(replacement.pendingPremiumFeeBps).toBe(200);
    expect(replacement.pendingEffectiveAt).toBe(200n + day);

    const afterDue = scheduledFeeColumns(replacement, initial, log, 200n + 2n * day, 200n + day);
    expect(afterDue.premiumFeeBps).toBe(200);
    expect(afterDue.pendingPremiumFeeBps).toBe(300);
  });
});
