import { describe, expect, it, vi } from "vitest";

// This file tests how alert options are built FROM a registry, so it pins its own. It used to read the
// real one and expect NVDA live there; the v8 registry (O8-01, a219a2ae) resets every v2 block to
// planned until the v8 broadcast, so that expectation became false while the logic stayed right.
vi.mock("@/lib/markets", () => {
  const markets = [
    { ticker: "NVDA", v2: { status: "live" } },
    { ticker: "AAPL", v2: { status: "planned" } },
  ];
  return {
    v2Markets: () => markets,
    liveV2Markets: () => markets.filter((market) => market.v2.status === "live"),
  };
});

import {
  PLANNED_ALERT_MARKET_NOTE,
  alertMarketOptions,
  alertMarketOptionsForQueryState,
  enabledAlertTickers,
} from "./notificationMarkets";

describe("notification price-alert markets", () => {
  it("offers only the current registry's live market when the indexer is unreachable", () => {
    expect(enabledAlertTickers(alertMarketOptions())).toEqual(["NVDA"]);
  });

  it("intersects registry-live markets with a reachable /v2/markets response", () => {
    expect(enabledAlertTickers(alertMarketOptions(["nvda", "AAPL"]))).toEqual(["NVDA"]);
    expect(enabledAlertTickers(alertMarketOptions([]))).toEqual([]);
  });

  it("uses the registry-live fallback when a failed refetch retains stale market data", () => {
    const retained = ["AAPL"];
    expect(enabledAlertTickers(alertMarketOptionsForQueryState(retained, false))).toEqual([]);
    expect(enabledAlertTickers(alertMarketOptionsForQueryState(retained, true))).toEqual(["NVDA"]);
  });

  it("keeps planned markets visible but disabled with the launch note", () => {
    expect(alertMarketOptions(["NVDA", "AAPL"]).find((option) => option.ticker === "AAPL"))
      .toEqual({ ticker: "AAPL", disabled: true, note: PLANNED_ALERT_MARKET_NOTE });
    expect(PLANNED_ALERT_MARKET_NOTE).toBe("alerts start when this market is live");
  });
});
