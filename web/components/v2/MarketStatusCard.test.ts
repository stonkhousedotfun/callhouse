import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { v2Markets, type V2Market } from "@/lib/markets";
import { V2_DEFAULTS } from "@/lib/markets.generated";
import type { MarketDirectoryRow } from "@/lib/v2/marketDirectory";

import { compactWait, MarketStatusCard, MINT_PAUSED_NOTE, registryFacts, settlementChips, statusPillOf } from "./MarketStatusCard";

const live: MarketDirectoryRow = {
  ticker: "NVDA",
  name: "NVIDIA • Robinhood Token",
  href: "/nvda",
  availability: "live",
  availabilityLabel: "Live",
  availabilityDetail: "Listed and enabled for trading.",
  tradeable: true,
  spot: { raw: "229030000", decimals: 6, formatted: "229.03" },
  spotUpdatedAt: Date.UTC(2026, 8, 22, 20, 0, 0) / 1000,
  settlement: { sourceCount: 2, uncorroboratedDelayS: 21_600, route: { venue: "v3", fee: 500 } },
  puts: true,
  seriesOpen: 0,
};

const facts = { sources: ["Chainlink", "Uniswap v3"], cadence: "Daily, up to 6 days out" } as const;
const render = (market: MarketDirectoryRow, withFacts = true) =>
  renderToStaticMarkup(createElement(MarketStatusCard, { market, facts: withFacts ? facts : undefined }));

function registryMarket(ticker: string): V2Market {
  const market = v2Markets().find((row) => row.ticker === ticker);
  if (!market) throw new Error(`${ticker} is not in the app registry`);
  return market;
}

describe("registry facts: source names and cadence come from the registry, not the mockup", () => {
  it("the launch pair NVDA and SPCX are each Chainlink plus a Uniswap v3 pool", () => {
    for (const ticker of ["NVDA", "SPCX"]) {
      const market = registryMarket(ticker);
      expect(market.v2.univ3Pool).not.toBeNull();
      expect(registryFacts(market).sources).toEqual(["Chainlink", "Uniswap v3"]);
    }
  });

  it("a market with no pool is Chainlink only", () => {
    const market = registryMarket("NVDA");
    expect(registryFacts({ ...market, v2: { ...market.v2, univ3Pool: null } }).sources).toEqual(["Chainlink"]);
  });

  it("the cadence mirrors v2.defaults.expiriesAhead, and a market override wins", () => {
    const market = registryMarket("NVDA");
    const { daily, weekly } = V2_DEFAULTS.expiriesAhead;
    // Mirrored from the registry at this commit (six daily closes, no weekly ladder), not re-reasoned.
    expect({ daily, weekly }).toEqual({ daily: 6, weekly: 0 });
    // ("List Mon/Wed/Fri only"): NVDA's row names its listing days.
    expect(registryFacts(market).cadence).toBe("Mon, Wed and Fri, up to 6 days out");
    const withOverride = (expiriesAhead: Record<string, number>) =>
      registryFacts({ ...market, v2: { ...market.v2, overrides: { expiriesAhead } } }).cadence;
    expect(withOverride({ daily: 1, weekly: 0 })).toBe("Daily, up to 1 day out");
    expect(withOverride({ daily: 0, weekly: 2 })).toBe("Fridays only (the week's last trading day), up to 2 weeks out");
    expect(withOverride({ daily: 3, weekly: 1 })).toBe("Daily and weekly, 3 daily closes ahead");
    expect(withOverride({ daily: 0, weekly: 0 })).toBeNull();
  });

  it("SPCX's own registry row (Friday closes, no dailies) reads as Fridays, never as daily", () => {
    const spcx = registryMarket("SPCX");
    expect(spcx.v2.overrides).toMatchObject({ expiriesAhead: { weekly: 2, daily: 0 } });
    expect(registryFacts(spcx).cadence).toBe("Fridays only (the week's last trading day), up to 2 weeks out");
    expect(registryFacts(spcx).cadence).not.toMatch(/daily/i);
    expect(registryFacts(registryMarket("NVDA")).cadence).toBe("Mon, Wed and Fri, up to 6 days out");
  });

  it("NVDA's row (dailyWeekdays mon, wed, fri) names those days; every-weekday dailies still read Daily", () => {
    const nvda = registryMarket("NVDA");
    expect(nvda.v2.overrides).toMatchObject({ dailyWeekdays: ["mon", "wed", "fri"] });
    expect(registryFacts(nvda).cadence).toBe("Mon, Wed and Fri, up to 6 days out");
    expect(registryFacts({ ...nvda, v2: { ...nvda.v2, overrides: {} } }).cadence).toBe("Daily, up to 6 days out");
    expect(registryFacts({ ...nvda, v2: { ...nvda.v2, overrides: { dailyWeekdays: ["fri"] } } }).cadence).toBe("Fri, up to 6 days out");
  });
});

describe("settlement chips", () => {
  it("compacts a configured wait without rounding it", () => {
    expect(compactWait(21_600)).toBe("6h");
    expect(compactWait(3_600)).toBe("1h");
    expect(compactWait(300)).toBe("5m");
    expect(compactWait(90)).toBe("90s");
    expect(compactWait(5_400)).toBe("90m");
  });

  it("names the sources only when the registry count matches the chain's", () => {
    expect(settlementChips(live.settlement, facts.sources)?.chips).toEqual(["2 sources", "Chainlink + Uniswap v3", "6h fallback wait"]);
    expect(settlementChips(live.settlement, ["Chainlink"])?.chips).toEqual(["2 sources", "6h fallback wait"]);
    expect(settlementChips(live.settlement)?.chips).toEqual(["2 sources", "6h fallback wait"]);
    expect(settlementChips({ sourceCount: 1, uncorroboratedDelayS: 3_600, route: null }, ["Chainlink"])?.chips)
      .toEqual(["1 source", "Chainlink", "1h uncorroborated wait"]);
  });

  it("keeps the long form as the group's summary and invents nothing when the indexer has no settlement row", () => {
    expect(settlementChips(live.settlement, facts.sources)?.summary).toBe("2 sources · 6 hours fallback wait");
    expect(settlementChips(undefined, facts.sources)).toBeNull();
  });
});

describe("status pill vocabulary", () => {
  it("maps the four market states onto the Neon pills and nothing else", () => {
    expect(statusPillOf("live")).toBe("live");
    expect(statusPillOf("coming-soon")).toBe("soon");
    expect(statusPillOf("paused")).toBe("paused");
    expect(statusPillOf("deferred")).toBe("deferred");
    expect(statusPillOf("checking")).toBeNull();
    expect(statusPillOf("unavailable")).toBeNull();
  });
});

describe("MarketStatusCard", () => {
  it("draws a live market's status card: Live, the token name and its figures", () => {
    const html = render(live);
    expect(html).toContain('data-status="live"');
    expect(html).toContain(">Live<");
    expect(html).toContain("NVIDIA • Robinhood Token");
    expect(html).toContain("$229.03");
    expect(html).toContain("Observed");
    expect(html).toContain("Sep 22, 4:00 PM EDT"); // server render (and hydration) shows New York, zone named; the browser switches to the reader's zone.
    expect(html).toContain("Daily, up to 6 days out");
    expect(html).toContain(">Chainlink + Uniswap v3<");
    expect(html).toContain(">6h fallback wait<");
    expect(html).toContain('aria-label="Settlement: 2 sources · 6 hours fallback wait"');
    expect(html).toContain("try USDG conversion, with Stock Tokens as fallback");
    expect(html).toContain('href="/nvda"');
    expect(html).toContain("Trade NVDA");
    // A live card does not repeat the availability sentence; the pill says it.
    expect(html).not.toContain("Listed and enabled for trading.");
  });

  it("shows 0 open series as 0 and an unknown count as a dash", () => {
    // The label may carry the cadence "?" (an InfoTip) before its </dt>; the value is still the next <dd>.
    expect(render(live)).toMatch(/Open series[\s\S]*?<\/dt><dd[^>]*>0<\/dd>/);
    expect(render({ ...live, seriesOpen: null })).toMatch(/Open series[\s\S]*?<\/dt><dd[^>]*>—<\/dd>/);
  });

  it("without registry facts it shows the chain's count and wait, and no names or cadence", () => {
    const html = render(live, false);
    expect(html).not.toContain("Chainlink");
    expect(html).not.toContain("days out");
    expect(html).toContain(">2 sources<");
  });

  it("a paused or planned market carries its pill and its sentence, and no trade link", () => {
    const paused = render({ ...live, availability: "paused", availabilityLabel: "Paused",
      availabilityDetail: "Trading is paused.", tradeable: false });
    expect(paused).toContain('data-status="paused"');
    expect(paused).toContain("Trading is paused.");
    expect(paused).toContain("Trading unavailable");
    expect(paused).not.toContain('href="/nvda"');

    const unknown = render({ ...live, availability: "unavailable", availabilityLabel: "Status unavailable",
      availabilityDetail: "Live status could not be read.", tradeable: false, spot: null, spotUpdatedAt: null,
      settlement: undefined, seriesOpen: null });
    expect(unknown).not.toContain("data-status=");
    expect(unknown).toContain("Status unavailable");
    expect(unknown).toContain(">Unavailable<");
    expect(unknown).not.toContain("Observed");
    expect(unknown).toContain("Details unavailable");
    // The explanatory line under the chip was dropped; what matters is still that nothing is inferred.
    expect(unknown).not.toMatch(/\d+ sources?</);
    expect(unknown).not.toMatch(/(fallback|uncorroborated) wait/);
  });
});

describe("the payout rule names puts only when this market's registry flag enables them", () => {
  it("puts:true shows today's full rule", () => {
    expect(render(live)).toContain("Winning calls try USDG conversion, with Stock Tokens as fallback · puts pay USDG");
  });

  it("puts:false, or a flag not yet read (null), shows the calls-only rule", () => {
    for (const puts of [false, null]) {
      const html = render({ ...live, puts });
      expect(html, String(puts)).toContain("Winning calls try USDG conversion, with Stock Tokens as fallback<");
      expect(html.toLowerCase(), String(puts)).not.toContain("put");
    }
  });
});

describe("MarketStatusCard: the mint brake", () => {
  it("a live market with minting paused says so, and still links to trade", () => {
    const out = render({ ...live, mintPaused: true });
    expect(out).toContain('data-slot="mint-paused"');
    expect(out).toContain(MINT_PAUSED_NOTE);
    expect(out).toContain("Trade NVDA");
  });

  it("no note without the flag, and none on a card that is not live", () => {
    expect(render(live)).not.toContain('data-slot="mint-paused"');
    const paused = { ...live, availability: "paused" as const, availabilityLabel: "Paused",
      availabilityDetail: "Trading is paused by the guardian: no order can be placed or taken.", tradeable: false, mintPaused: true };
    const out = render(paused);
    expect(out).not.toContain('data-slot="mint-paused"');
    expect(out).toContain("Trading is paused by the guardian");
    expect(out).not.toContain("Trade NVDA");
  });
});
