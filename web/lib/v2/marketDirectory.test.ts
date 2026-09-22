import { describe, expect, it } from "vitest";

import type { Market } from "./api-types";
import {
  filterMarketDirectory,
  formatConfiguredDelay,
  marketDirectoryRows,
  settlementModeLabel,
  settlementPayoutLabel,
  type MarketDirectoryRegistryRow,
} from "./marketDirectory";

const money = (raw = "100000000"): Market["spot"] => ({ raw, decimals: 6, formatted: "100" });

function registry(
  ticker: string,
  status: MarketDirectoryRegistryRow["v2"]["status"],
  wave: MarketDirectoryRegistryRow["v2"]["wave"],
  registeredAt: number | null,
  // T-OP-099. Launch-set membership is data on the row (lib/markets.ts computes it from the registry's
  // launchSet). The cases below that are about status/wave/API use launch rows; the launch-set cases set it.
  launch = true,
): MarketDirectoryRegistryRow {
  return { ticker, name: `${ticker} Company • Robinhood Token`, launch, v2: { status, wave, registeredAt } };
}

function api(ticker: string, overrides: Partial<Market> = {}): Market {
  return {
    ticker,
    name: `${ticker} Company • Robinhood Token`,
    underlying: "0x0000000000000000000000000000000000000001",
    status: "live",
    launch: true, // T-OP-099: the wire's launch flag; the directory decides from the registry row, not from this.
    spot: money(),
    spotUpdatedAt: 1_000,
    strikeTick: money("1000000")!,
    puts: false,
    mintFeePpm: 80,
    expiries: [2_000],
    stats: {
      volume24h: money("0")!, premium7d: money("0")!, asOf: 1_000, openInterestUnits: "0", seriesOpen: 1,
    },
    ...overrides,
  };
}

describe("market directory registry/API merge", () => {
  it("requires both a released registry row and current API-live state before offering a trade", () => {
    const rows = marketDirectoryRows([
      registry("LIVE", "live", "canary", 10),
      registry("STAGED", "planned", "wave1", 11),
      registry("PAUSED", "paused", "wave1", 12),
    ], { kind: "ready", markets: [api("LIVE"), api("STAGED"), api("PAUSED")] });

    expect(rows.find((row) => row.ticker === "LIVE")).toMatchObject({ availability: "live", tradeable: true });
    expect(rows.find((row) => row.ticker === "STAGED")).toMatchObject({ availability: "coming-soon", tradeable: false });
    expect(rows.find((row) => row.ticker === "PAUSED")).toMatchObject({ availability: "paused", tradeable: false });
  });

  it("derives coming-soon and deferred copy from launch-set membership, not from waves (T-OP-099)", () => {
    // Before T-OP-099 `wave` decided: planned+wave1 read as "Coming soon" and wave2 as "Deferred". Now
    // membership decides and the wave is irrelevant: a planned LAUNCH market is coming soon whatever its
    // wave, and a NON-launch market is deferred whatever its wave -- including wave1 and canary.
    const rows = marketDirectoryRows([
      registry("NEXT", "planned", "wave1", null, true),
      registry("SOON2", "planned", "wave2", null, true),
      registry("OUT1", "planned", "wave1", null, false),
      registry("OUTC", "planned", "canary", null, false),
      registry("LATER", "planned", "wave2", null, false),
    ], { kind: "ready", markets: [] });

    expect(rows.find((row) => row.ticker === "NEXT")).toMatchObject({
      availability: "coming-soon", availabilityLabel: "Coming soon", tradeable: false,
    });
    expect(rows.find((row) => row.ticker === "SOON2")).toMatchObject({ availability: "coming-soon", tradeable: false });
    expect(rows.filter((row) => row.availability === "deferred").map((row) => row.ticker)).toEqual(["LATER", "OUT1", "OUTC"]);
    expect(rows.find((row) => row.ticker === "OUT1")?.availabilityDetail).toContain("Not in the launch set");
    expect(rows.find((row) => row.ticker === "OUT1")?.availabilityDetail).toContain("no launch timing is promised");
  });

  it("never offers a trade on a market outside the launch set, even one the chain registered live (T-OP-099)", () => {
    // What `--wave wave1` at broadcast would produce: registered and live on chain, not in the owner's set.
    const rows = marketDirectoryRows([
      registry("NVDA", "live", "canary", 10, true),
      registry("OFF", "live", "wave1", 11, false),
      registry("OFFP", "paused", "wave1", 12, false),
    ], { kind: "ready", markets: [api("NVDA"), api("OFF"), api("OFFP", { status: "paused" })] });
    expect(rows.find((row) => row.ticker === "NVDA")).toMatchObject({ availability: "live", tradeable: true });
    expect(rows.find((row) => row.ticker === "OFF")).toMatchObject({ availability: "deferred", tradeable: false });
    // Paused is a launch-market state; outside the set the answer is still "deferred".
    expect(rows.find((row) => row.ticker === "OFFP")).toMatchObject({ availability: "deferred", tradeable: false });
    // And no API state can promote a non-launch row: loading, error and ready all say deferred.
    for (const apiState of [{ kind: "loading" as const }, { kind: "error" as const }]) {
      expect(marketDirectoryRows([registry("OFF", "live", "wave1", 11, false)], apiState)[0]).toMatchObject({ availability: "deferred", tradeable: false });
    }
  });

  it("fails closed for missing, loading, failed, and internally inconsistent live rows", () => {
    const released = [registry("NVDA", "live", "canary", 10)];
    expect(marketDirectoryRows(released, { kind: "loading" })[0]).toMatchObject({ availability: "checking", tradeable: false });
    expect(marketDirectoryRows(released, { kind: "error" })[0]).toMatchObject({
      availability: "unavailable", tradeable: false, spot: null, settlement: undefined,
    });
    expect(marketDirectoryRows(released, { kind: "ready", markets: [] })[0]).toMatchObject({ availability: "unavailable", tradeable: false });
    expect(marketDirectoryRows([registry("NVDA", "live", "canary", null)], {
      kind: "ready", markets: [api("NVDA")],
    })[0]).toMatchObject({ availability: "unavailable", tradeable: false });
  });

  it("does not reuse spot or settlement metadata after an API error", () => {
    const stale = api("NVDA", {
      settlement: { sourceCount: 2, uncorroboratedDelayS: 21_600, route: { venue: "v3", fee: 500 } },
    });
    const ready = marketDirectoryRows([registry("NVDA", "live", "canary", 10)], { kind: "ready", markets: [stale] })[0]!;
    const failed = marketDirectoryRows([registry("NVDA", "live", "canary", 10)], { kind: "error" })[0]!;
    expect(ready.spot).not.toBeNull();
    expect(ready.settlement).toBeDefined();
    expect(failed).toMatchObject({ spot: null, spotUpdatedAt: null, settlement: undefined });
  });

  it("searches by ticker or issuer name and can narrow by lifecycle", () => {
    const rows = marketDirectoryRows([
      { ...registry("NVDA", "live", "canary", 10), name: "NVIDIA • Robinhood Token" },
      { ...registry("TSLA", "planned", "wave1", null), name: "Tesla • Robinhood Token" },
    ], { kind: "ready", markets: [api("NVDA")] });
    expect(filterMarketDirectory(rows, "nvid").map((row) => row.ticker)).toEqual(["NVDA"]);
    expect(filterMarketDirectory(rows, "tsl").map((row) => row.ticker)).toEqual(["TSLA"]);
    expect(filterMarketDirectory(rows, "", "coming-soon").map((row) => row.ticker)).toEqual(["TSLA"]);
  });
});

describe("market settlement badges", () => {
  it("keeps absent optional metadata unknown instead of inferring a source or payout", () => {
    expect(settlementModeLabel(undefined)).toBeNull();
    expect(settlementPayoutLabel(undefined)).toBeNull();
  });

  it("describes the configured delay without promising a settlement time", () => {
    expect(settlementModeLabel({ sourceCount: 1, uncorroboratedDelayS: 3_600, route: null }))
      .toBe("1 source · 1 hour uncorroborated wait");
    expect(settlementModeLabel({ sourceCount: 2, uncorroboratedDelayS: 21_600, route: null }))
      .toBe("2 sources · 6 hours fallback wait");
    expect(formatConfiguredDelay(1_800)).toBe("30 minutes");
  });

  it("distinguishes in-kind calls from a conversion attempt and keeps puts in USDG", () => {
    expect(settlementPayoutLabel({ sourceCount: 1, uncorroboratedDelayS: 3_600, route: null }))
      .toBe("Winning calls pay Stock Tokens · puts pay USDG");
    expect(settlementPayoutLabel({
      sourceCount: 2, uncorroboratedDelayS: 21_600, route: { venue: "v3", fee: 500 },
    })).toBe("Winning calls try USDG conversion, with Stock Tokens as fallback · puts pay USDG");
  });
});
