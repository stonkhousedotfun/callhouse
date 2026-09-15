import { describe, expect, it } from "vitest";

import { deriveFillState, FILL_STATE_COPY, vaultGuards, type FillState } from "./vaultStatus";

const NOW = 1_800_000_100;

describe("deriveFillState", () => {
  it("is unknown until a phase has been read", () => {
    expect(deriveFillState({}, NOW)).toBe("unknown");
    expect(deriveFillState({ phase: undefined }, NOW)).toBe("unknown");
  });

  it("Idle with no claim is flat; Idle with a claim is stranded", () => {
    expect(deriveFillState({ phase: 0 }, NOW)).toBe("flat");
    expect(deriveFillState({ phase: 0, claimKey: 0n }, NOW)).toBe("flat");
    expect(deriveFillState({ phase: 0, claimKey: 1n }, NOW)).toBe("stranded");
  });

  it("Listed is armed / selling / filled from sold and remaining capacity", () => {
    expect(deriveFillState({ phase: 1, contractsWritten: 0n, capacity: 10n }, NOW)).toBe("armed");
    expect(deriveFillState({ phase: 1, contractsWritten: 3n, capacity: 7n }, NOW)).toBe("selling");
    expect(deriveFillState({ phase: 1, contractsWritten: 10n, capacity: 0n }, NOW)).toBe("filled");
  });

  it("Listed past the exercise time is closed, whatever the phase says", () => {
    const v = { phase: 1, cycleExerciseTs: NOW - 1, contractsWritten: 3n, capacity: 7n };
    expect(deriveFillState(v, NOW)).toBe("locked");
    expect(deriveFillState({ ...v, contractsWritten: 0n }, NOW)).toBe("unfilled");
    expect(deriveFillState({ ...v, contractsAssigned: 2n }, NOW)).toBe("assigned");
  });

  it("does not infer from the clock before the client has mounted (nowSeconds == 0)", () => {
    expect(
      deriveFillState({ phase: 1, cycleExerciseTs: 1, contractsWritten: 3n, capacity: 7n }, 0),
    ).toBe("selling");
  });

  it("Exercisable is assigned / locked / unfilled; Settling is settling", () => {
    expect(deriveFillState({ phase: 2, contractsWritten: 0n }, NOW)).toBe("unfilled");
    expect(deriveFillState({ phase: 2, contractsWritten: 3n }, NOW)).toBe("locked");
    expect(deriveFillState({ phase: 2, contractsWritten: 3n, contractsAssigned: 1n }, NOW)).toBe("assigned");
    expect(deriveFillState({ phase: 3, contractsWritten: 3n }, NOW)).toBe("settling");
  });

  it("names every fill state in FILL_STATE_COPY", () => {
    const states: FillState[] = [
      "unknown",
      "flat",
      "stranded",
      "armed",
      "selling",
      "filled",
      "locked",
      "settling",
      "assigned",
      "unfilled",
    ];
    for (const s of states) expect(FILL_STATE_COPY[s].length).toBeGreaterThan(0);
  });
});

describe("vaultGuards", () => {
  it("is empty when nothing is stopping the vault", () => {
    expect(vaultGuards({})).toEqual([]);
    expect(vaultGuards({ valoremFeeAccepted: false, clearFeesEnabled: false })).toEqual([]);
  });

  it("orders the stops most severe first, and treats an accepted fee as info not a stop", () => {
    const guards = vaultGuards({
      isStranded: true,
      writesHalted: true,
      oraclePaused: true,
      spotStale: true,
      clearFeesEnabled: true,
      valoremFeeAccepted: true,
    });
    expect(guards.map((g) => g.key)).toEqual(["stranded", "halt", "oracle", "spot", "fee"]);
    expect(guards.find((g) => g.key === "fee")?.tone).toBe("info");
    expect(guards.find((g) => g.key === "fee")?.label).toBe("Valorem fee on, accepted");
  });

  it("the fee switch ON without acceptance is a stop; acceptance with the switch off is info", () => {
    const stop = vaultGuards({ clearFeesEnabled: true, valoremFeeAccepted: false });
    expect(stop).toEqual([
      expect.objectContaining({ key: "fee", tone: "bad", label: "Valorem fee on, not accepted: no arm, no fill" }),
    ]);
    const acceptedOff = vaultGuards({ clearFeesEnabled: false, valoremFeeAccepted: true });
    expect(acceptedOff).toEqual([expect.objectContaining({ key: "fee", tone: "info", label: "Valorem fee accepted" })]);
  });
});
