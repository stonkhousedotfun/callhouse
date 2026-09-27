import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Market } from "@/lib/v2/api-types";
import { SettlementDisclosure, configuredWaitLabel, settlementDisclosure } from "./SettlementDisclosure";

const fixture = fileURLToPath(new URL("../../../ops/fixtures/api/v2/markets.json", import.meta.url));
const markets = JSON.parse(readFileSync(fixture, "utf8")) as Market[];
const market = (ticker: string) => markets.find((item) => item.ticker === ticker)!;

describe("market settlement disclosure", () => {
  it("uses the one-source fixture delay and names the unrouted call payout", () => {
    const tsla = market("TSLA");
    const html = renderToStaticMarkup(createElement(SettlementDisclosure, {
      settlement: tsla.settlement,
      isPut: false,
      ticker: tsla.ticker,
    }));

    // plain words; the timing sits in the heading's "?" and the payout is the one visible line.
    expect(html).toContain("This market has one price source");
    expect(html).toContain("waits about 1 hour");
    expect(html).toMatch(/Settlement and payout <span[^>]*><button[^>]*aria-label="About settlement timing"/);
    expect(html).toContain("winning calls pay TSLA Stock Tokens.");
    expect(html).toContain("no USDG conversion route configured");
  });

  it("describes a v3 routed call as an attempt without inventing a pool address", () => {
    const nvda = market("NVDA");
    const copy = settlementDisclosure(nvda.settlement, false, nvda.ticker);

    expect(copy.timing).toContain("This market has 2 price sources");
    expect(copy.timing).toContain("about 6 hours");
    expect(copy.payout).toContain("a listed Uniswap v3 route tries to convert them to USDG");
    expect(copy.payout).toContain("if that fails or pays too little, you get the tokens");
    expect(copy.payout).not.toContain("pool address");
    expect(copy.payout).not.toContain("will convert");
  });

  it("identifies a v4 route as a pool route without promising conversion", () => {
    const copy = settlementDisclosure({
      sourceCount: 2,
      uncorroboratedDelayS: 21_600,
      route: {
        venue: "v4",
        fee: 100,
        tickSpacing: 10,
        poolId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
    }, false, "nvda");

    expect(copy.payout).toContain("a listed Uniswap v4 route tries to convert them to USDG");
    expect(copy.payout).toContain("if that fails or pays too little, you get the tokens");
    expect(copy.payout).not.toContain("will convert");
  });

  it("keeps puts in USDG and degrades honestly when metadata is absent", () => {
    expect(settlementDisclosure(undefined, true, "TSLA")).toEqual({
      timing: "Settlement timing is unavailable. Watch the option's status after expiry.",
      payout: "Winning puts pay USDG.",
    });

    const call = settlementDisclosure(undefined, false, "nvda");
    expect(call.payout).toContain("Winning calls are owed NVDA Stock Tokens");
    expect(call.payout).toContain("Conversion details are unavailable");
    expect(call.payout).toContain("if conversion fails, you get the tokens");
    expect(call.payout).not.toContain("will convert");
  });

  it("formats the configured delay instead of hard-coding one hour", () => {
    expect(configuredWaitLabel(1_800)).toBe("30 minutes");
    expect(configuredWaitLabel(5_400)).toBe("1 hour 30 minutes");
    expect(configuredWaitLabel(86_400)).toBe("1 day");
  });
});
