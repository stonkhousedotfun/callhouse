import { describe, expect, it } from "vitest";

import { countdownLabel, houseDepositsOpen, launchGatePhase, soonestPendingHouseGate } from "./launchGates";

describe("launch gates", () => {
  it("derives the phase from the effect, the schedule and the clock", () => {
    expect(launchGatePhase({ done: true, scheduledAt: 0 }, 100)).toBe("done");
    expect(launchGatePhase({ done: true, scheduledAt: 500 }, 100)).toBe("done");
    expect(launchGatePhase({ done: false, scheduledAt: 0 }, 100)).toBe("unscheduled");
    expect(launchGatePhase({ done: false, scheduledAt: 101 }, 100)).toBe("counting");
    expect(launchGatePhase({ done: false, scheduledAt: 100 }, 100)).toBe("due");
    expect(launchGatePhase({ done: false, scheduledAt: 99 }, 100)).toBe("due");
  });

  it("formats a countdown with days only when there are days, and never negative", () => {
    expect(countdownLabel(0)).toBe("00:00:00");
    expect(countdownLabel(-5)).toBe("00:00:00");
    expect(countdownLabel(59)).toBe("00:00:59");
    expect(countdownLabel(3600 + 120 + 3)).toBe("01:02:03");
    expect(countdownLabel(86_400 + 3600 + 5)).toBe("1d 01:00:05");
    expect(countdownLabel(2 * 86_400)).toBe("2d 00:00:00");
  });

  it("opens House deposits only on the effect, never on a schedule", () => {
    // The only opener: the arming is read back on chain.
    expect(houseDepositsOpen({ done: true, scheduledAt: 0 }, 100)).toBe(true);
    // Scheduled and even executable is NOT armed — protocolAccountsConfirmed is still false until the
    // Safe sends the execute, so the vault still quotes nothing and a deposit would sit idle.
    expect(houseDepositsOpen({ done: false, scheduledAt: 101 }, 100)).toBe(false);
    expect(houseDepositsOpen({ done: false, scheduledAt: 100 }, 100)).toBe(false);
    expect(houseDepositsOpen({ done: false, scheduledAt: 0 }, 100)).toBe(false);
    // Fail closed: an unread gate (still loading, or the chain read errored) must not open the control.
    expect(houseDepositsOpen(undefined, 100)).toBe(false);
  });

  it("picks the soonest pending House arming for an index row, and nothing once all are armed", () => {
    const armed = { done: true, scheduledAt: 0 };
    expect(soonestPendingHouseGate({ NVDA: armed, SPCX: armed }, 100)).toBeNull();
    expect(soonestPendingHouseGate(undefined, 100)).toBeNull();
    expect(soonestPendingHouseGate({}, 100)).toBeNull();

    const soon = { done: false, scheduledAt: 200 };
    const later = { done: false, scheduledAt: 900 };
    expect(soonestPendingHouseGate({ NVDA: later, SPCX: soon }, 100)?.ticker).toBe("SPCX");
    // One armed, one not: the row still counts down to the one that is not.
    expect(soonestPendingHouseGate({ NVDA: armed, SPCX: later }, 100)?.ticker).toBe("SPCX");
    // Unscheduled is still pending, and sorts behind every scheduled gate rather than reading as open.
    const unscheduled = { done: false, scheduledAt: 0 };
    expect(soonestPendingHouseGate({ NVDA: unscheduled }, 100)?.ticker).toBe("NVDA");
    expect(soonestPendingHouseGate({ NVDA: unscheduled, SPCX: later }, 100)?.ticker).toBe("SPCX");
  });
});
