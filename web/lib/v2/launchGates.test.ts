import { describe, expect, it } from "vitest";

import { countdownLabel, launchGatePhase } from "./launchGates";

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
});
