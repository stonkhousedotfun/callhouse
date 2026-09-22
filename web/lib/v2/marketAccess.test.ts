import { describe, expect, it } from "vitest";

import { marketAccess, NOT_LISTED_LABEL, type MarketAccessInput } from "./marketAccess";

describe("v2 market route access", () => {
  const fixtures: Array<{ name: string; input: MarketAccessInput; expected: ReturnType<typeof marketAccess> }> = [
    {
      name: "known but not registered",
      input: { registered: false, releaseStatus: "planned", enablement: "disabled", executableAskUnits: 0n },
      expected: { registered: false, enabled: false, routeState: "not-listed", hasExecutableOrder: false },
    },
    {
      name: "registered disabled staging row",
      input: { registered: true, releaseStatus: "planned", enablement: "disabled", executableAskUnits: 0n },
      expected: { registered: true, enabled: false, routeState: "not-listed", hasExecutableOrder: false },
    },
    {
      name: "paused after listing",
      input: { registered: true, releaseStatus: "paused", enablement: "disabled", executableAskUnits: 100n },
      expected: { registered: true, enabled: false, routeState: "not-listed", hasExecutableOrder: false },
    },
    {
      name: "enabled market with an empty book",
      input: { registered: true, releaseStatus: "live", enablement: "enabled", executableAskUnits: 0n },
      expected: { registered: true, enabled: true, routeState: "listed", hasExecutableOrder: false },
    },
    {
      name: "enabled market with an executable ask",
      input: { registered: true, releaseStatus: "live", enablement: "enabled", executableAskUnits: 100n },
      expected: { registered: true, enabled: true, routeState: "listed", hasExecutableOrder: true },
    },
  ];

  for (const fixture of fixtures) {
    it(fixture.name, () => expect(marketAccess(fixture.input)).toEqual(fixture.expected));
  }

  it("fails closed while enablement is unknown without pretending the market is unlisted", () => {
    expect(marketAccess({ registered: true, releaseStatus: "live", enablement: "checking" }).routeState).toBe("checking");
    expect(marketAccess({ registered: true, releaseStatus: "live", enablement: "unavailable" }).routeState).toBe("unavailable");
    expect(NOT_LISTED_LABEL).toBe("Not listed yet");
  });
});
