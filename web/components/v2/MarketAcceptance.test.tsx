import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Market } from "@/lib/v2/api-types";
import {
  marketDirectoryRows,
  type MarketDirectoryRegistryRow,
  type MarketDirectoryRow,
} from "@/lib/v2/marketDirectory";
import { autoRollTargetStrike } from "@/lib/v2/smartPricing";

import { ConversionFloorCopy } from "./ConversionFloor";
import { MarketDirectoryCard } from "./MarketDirectory";
import { SettlementDisclosure } from "./SettlementDisclosure";

const marketsFixture = fileURLToPath(new URL("../../../ops/fixtures/api/v2/markets.json", import.meta.url));
const registryFixture = fileURLToPath(new URL("../../../ops/markets/tier1.json", import.meta.url));

const fixtureMarkets = JSON.parse(readFileSync(marketsFixture, "utf8")) as Market[];
const registry = JSON.parse(readFileSync(registryFixture, "utf8")) as { markets: Array<{ ticker: string }> };

/** A 10 USDG strike tick: coarser than either launch market's. It used to be read off SNDK's registry row
 * removed SNDK with the other non-launch markets, so the synthetic row states its own tick. */
const COARSE_TICK = "10000000";

function fixtureMarket(ticker: string): Market {
  const market = fixtureMarkets.find((item) => item.ticker === ticker);
  if (!market) throw new Error(`Missing ${ticker} acceptance fixture`);
  return market;
}

function enabledRegistryRow(market: Market): MarketDirectoryRegistryRow {
  return {
    ticker: market.ticker,
    name: market.name,
    launch: true, // An enabled row here is a launch-set row; membership is data on the row.
    v2: { status: "live", wave: "canary", registeredAt: 1 },
  };
}

function renderMarketSurface(market: Market, row: MarketDirectoryRow) {
  const settlement = market.settlement;
  if (settlement === undefined) throw new Error(`${market.ticker} is missing settlement metadata`);

  const conversionState = settlement.route === null
    ? { kind: "unrouted" as const }
    : { kind: "routed" as const, floorBps: 9_920 };

  return {
    directory: renderToStaticMarkup(createElement(MarketDirectoryCard, { market: row })),
    disclosure: renderToStaticMarkup(createElement(SettlementDisclosure, {
      settlement,
      isPut: false,
      ticker: market.ticker,
    })),
    conversion: renderToStaticMarkup(createElement(ConversionFloorCopy, { state: conversionState })),
  };
}

describe("three-market presentation acceptance", () => {
  it("keeps pooled routing, single-source in-kind payout, and a synthetic coarse tick connected", () => {
    const pooledRouted = fixtureMarket("NVDA");
    const singleSourceUnrouted = fixtureMarket("TSLA");

    // A third, explicitly synthetic enabled API input with a coarse tick. It is not a registry market.
    expect(registry.markets.some((market) => market.ticker === "SYNTH-COARSE")).toBe(false);
    const syntheticCoarse: Market = {
      ...singleSourceUnrouted,
      ticker: "SYNTH-COARSE",
      name: "Synthetic coarse-tick acceptance market",
      strikeTick: { raw: COARSE_TICK, decimals: 6, formatted: "10" },
    };

    const inputs = [pooledRouted, singleSourceUnrouted, syntheticCoarse];
    const rows = marketDirectoryRows(inputs.map(enabledRegistryRow), { kind: "ready", markets: inputs });
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.availability === "live" && row.tradeable)).toBe(true);

    const row = (ticker: string) => {
      const found = rows.find((item) => item.ticker === ticker);
      if (!found) throw new Error(`Missing ${ticker} directory row`);
      return found;
    };
    const pooled = renderMarketSurface(pooledRouted, row(pooledRouted.ticker));
    const unrouted = renderMarketSurface(singleSourceUnrouted, row(singleSourceUnrouted.ticker));
    const coarse = renderMarketSurface(syntheticCoarse, row(syntheticCoarse.ticker));

    expect(pooled.directory).toContain("2 sources · 6 hours fallback wait");
    expect(pooled.directory).toContain("try USDG conversion, with Stock Tokens as fallback");
    // SettlementDisclosure's copy in plain words (the settlement timing sits in its "?").
    expect(pooled.disclosure).toContain("This market has 2 price sources");
    expect(pooled.disclosure).toContain("waits about 6 hours");
    expect(pooled.disclosure).toContain("a listed Uniswap v3 route tries to convert them to USDG");
    expect(pooled.conversion).toContain("USDG conversion pays at least 99.2%"); // plain copy, no zero tail

    expect(unrouted.directory).toContain("1 source · 1 hour uncorroborated wait");
    expect(unrouted.directory).toContain("Winning calls pay Stock Tokens");
    expect(unrouted.disclosure).toContain("This market has one price source");
    expect(unrouted.disclosure).toContain("waits about 1 hour");
    expect(unrouted.disclosure).toContain("no USDG conversion route configured");
    expect(unrouted.conversion).toContain("Winning calls are paid in Stock Tokens");
    expect(unrouted.conversion).not.toContain("pays at least");

    expect(coarse.directory).toContain("Synthetic coarse-tick acceptance market");
    expect(coarse.directory).not.toContain("SNDK");
    expect(autoRollTargetStrike(
      200_000_001n,
      500,
      BigInt(syntheticCoarse.strikeTick.raw),
    )).toBe(220_000_000n);
  });
});
