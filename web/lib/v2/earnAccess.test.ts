import { describe, expect, it } from "vitest";

import { earnActionAvailability, type EarnActionInputs } from "./earnAccess";

const deployed: EarnActionInputs = {
  walletConnected: true, assetConfigured: true, clearinghouseConfigured: true,
  orderBookConfigured: true, calendarConfigured: true, autoRollerConfigured: true,
  marketLive: true, marketMatchesRegistry: true, indexerConfigHealthy: true,
};

describe("Earn action availability", () => {
  it("keeps on-chain exits available when the indexer is down or the market is paused", () => {
    for (const change of [{ indexerConfigHealthy: false }, { marketLive: false }, { marketMatchesRegistry: false }]) {
      expect(earnActionAvailability({ ...deployed, ...change })).toEqual({
        exitReady: true, pauseReady: true, newWritesReady: false,
      });
    }
  });

  it("needs only the Clearinghouse for withdrawal and AutoRoller for pause", () => {
    expect(earnActionAvailability({ ...deployed, orderBookConfigured: false, calendarConfigured: false })).toEqual({
      exitReady: true, pauseReady: true, newWritesReady: false,
    });
    expect(earnActionAvailability({ ...deployed, autoRollerConfigured: false })).toEqual({
      exitReady: true, pauseReady: false, newWritesReady: true,
    });
    expect(earnActionAvailability({ ...deployed, clearinghouseConfigured: false })).toEqual({
      exitReady: false, pauseReady: false, newWritesReady: false,
    });
  });
});
