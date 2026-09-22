import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StrikeLadder, formatDeltaChance, ladderBuyHref, type LadderRow, type LadderView } from "./MarketPage";
import type { Card, Money, SeriesRef } from "@/lib/v2/api-types";

const money = (raw: string, formatted: string, decimals = 6): Money => ({ raw, decimals, formatted });

const seriesRef = (over: Partial<SeriesRef> = {}): SeriesRef => ({
  longId: "101",
  shortId: "201",
  ticker: "NVDA",
  underlying: "0x0000000000000000000000000000000000000001",
  isPut: false,
  strike: money("225000000", "225.00"),
  expiry: 1_790_000_000,
  tenor: "weekly",
  mintCutoff: 1_789_900_000,
  mintFeePpm: 80,
  mintFeesHeld: money("0", "0.00"),
  mintFeesAccrued: money("0", "0.00"),
  status: "open",
  ...over,
});

const row = (over: Partial<LadderRow> = {}, quoteOver: Partial<LadderRow["quote"]> = {}): LadderRow => ({
  series: seriesRef(),
  quote: {
    bestBid: money("400000", "0.40"),
    bestAsk: money("500000", "0.50"),
    bidUnits: "300",
    askUnits: "700",
    fair: money("480000", "0.48"),
    iv: 0.42,
    delta: 0.62,
    last: null,
    fairProvenance: null,
    ...quoteOver,
  },
  openInterestUnits: "1200",
  volume24h: money("0", "0.00"),
  ...over,
});

const card = (longId: string, multiple: number): Card => ({
  series: seriesRef({ longId }),
  spot: money("215500000", "215.50"),
  ask: money("500000", "0.50"),
  target: money("250000000", "250.00"),
  perUnit: { cost: money("500000", "0.50"), payoutAtTarget: money("2500000", "2.50"), multiple },
  perShare: null,
  maxLoss: "cost",
  unitsAvailable: "700",
  orderIds: ["1"],
});

const ladder = (view: LadderView, rows: LadderRow[], cards: Card[] = [card("101", 5)]) =>
  renderToStaticMarkup(createElement(StrikeLadder, {
    ticker: "NVDA",
    rows,
    cardById: new Map(cards.map((item) => [item.series.longId, item])),
    spot: 215_500_000n,
    view,
  }));

describe("formatDeltaChance", () => {
  it("renders the magnitude as a whole percent, so a put's negative delta is not shown as a negative chance", () => {
    expect(formatDeltaChance(0.62)).toBe("62%");
    expect(formatDeltaChance(-0.3)).toBe("30%");
    expect(formatDeltaChance(1)).toBe("100%");
    expect(formatDeltaChance(0)).toBe("0%");
  });

  it("is an em dash when the pricing service gave no delta, never a 0% that reads as a real answer", () => {
    expect(formatDeltaChance(null)).toBe("—");
    expect(formatDeltaChance(undefined)).toBe("—");
    expect(formatDeltaChance(Number.NaN)).toBe("—");
    expect(formatDeltaChance(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("ladderBuyHref", () => {
  it("carries buy=1 and NO shares param, so the ticket keeps W1's dollar-first default", () => {
    expect(ladderBuyHref("NVDA", "101")).toBe("/nvda/101?buy=1");
    expect(ladderBuyHref("NVDA", "101")).not.toContain("shares=");
  });
});

describe("StrikeLadder", () => {
  it("Simple shows the five decision columns plus Buy and hides the five pro-only ones", () => {
    const html = ladder("simple", [row()]);
    for (const header of ["Strike", "OTM", "Price / share", "Delta", "At target", "Trade"]) {
      expect(html).toContain(`<th scope="col">${header}</th>`);
    }
    for (const hidden of ["Bid / share", "Ask / 0.01", "Fair", "Ask vs fair", "Ask depth", "Open interest"]) {
      expect(html).not.toContain(`<th scope="col">${hidden}</th>`);
    }
    expect(html).toContain("62%");
  });

  it("Pro keeps every column the ten-column ladder had, and still buys from the row", () => {
    const html = ladder("pro", [row()]);
    for (const header of ["Strike", "OTM", "Bid / share", "Ask / share", "Ask / 0.01", "Fair",
      "Ask vs fair", "Delta", "At target", "Ask depth", "Open interest", "Trade"]) {
      expect(html).toContain(`<th scope="col">${header}</th>`);
    }
    expect(html).toContain('href="/nvda/101?buy=1"');
  });

  it("buys from the row rather than navigating to the series page first", () => {
    const html = ladder("simple", [row()]);
    expect(html).toContain('href="/nvda/101?buy=1"');
    expect(html).toContain(">Buy<");
  });

  it("offers no Buy on a strike with no ask, rather than a button that cannot fill", () => {
    const html = ladder("simple", [row({}, { bestAsk: null })]);
    expect(html).not.toContain("?buy=1");
    expect(html).toContain("No ask");
  });

  it("shows an em dash for a missing delta instead of dropping the column", () => {
    const html = ladder("simple", [row({}, { delta: null })]);
    expect(html).toContain("—");
    expect(html).not.toContain("0%");
  });

  it("widens the scroll region only for Pro, so Simple fits a phone", () => {
    expect(ladder("simple", [row()])).toContain("560px");
    expect(ladder("pro", [row()])).toContain("1060px");
  });
});
