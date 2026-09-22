import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketDirectoryCard } from "./MarketDirectory";
import type { MarketDirectoryRow } from "@/lib/v2/marketDirectory";

const base: MarketDirectoryRow = {
  ticker: "NVDA",
  name: "NVIDIA • Robinhood Token",
  href: "/nvda",
  availability: "live",
  availabilityLabel: "Live",
  availabilityDetail: "Listed and enabled for trading.",
  tradeable: true,
  spot: { raw: "215500000", decimals: 6, formatted: "215.5" },
  spotUpdatedAt: 1_000,
  settlement: { sourceCount: 2, uncorroboratedDelayS: 21_600, route: { venue: "v3", fee: 500 } },
  puts: false,
  seriesOpen: 15,
};

describe("market directory cards", () => {
  it("links only a confirmed live row and labels conversion as an attempt with in-kind fallback", () => {
    const html = renderToStaticMarkup(createElement(MarketDirectoryCard, { market: base }));
    expect(html).toContain('href="/nvda"');
    expect(html).toContain("2 sources · 6 hours fallback wait");
    expect(html).toContain("try USDG conversion, with Stock Tokens as fallback");
    expect(html).toContain("puts pay USDG");
  });

  it("keeps a planned row non-tradeable and does not invent absent settlement metadata", () => {
    const html = renderToStaticMarkup(createElement(MarketDirectoryCard, { market: {
      ...base,
      ticker: "AAPL",
      href: "/aapl",
      availability: "coming-soon",
      availabilityLabel: "Coming soon",
      availabilityDetail: "Included in the next registry release, but not open for trading yet.",
      tradeable: false,
      spot: null,
      spotUpdatedAt: null,
      settlement: undefined,
      seriesOpen: null,
    } }));
    expect(html).not.toContain('href="/aapl"');
    expect(html).toContain("Trading unavailable");
    expect(html).toContain("Details unavailable");
    expect(html).toContain("No source count, wait, or payout route is inferred");
  });
});

/**
 * T-431: "Feed observed" uses the shared `stamp()`, not the local SPOT_TIME formatter it replaced.
 * The one visible change is the YEAR: SPOT_TIME printed "Sep 21, 4:00 PM EDT" and stamp() prints
 * "Sep 21, 2026, 4:00 PM EDT" (coordinator ruling M-778d94690c34464b, item 4). Same New York
 * wall-clock time on each side of the daylight-saving change, so the zone name has to follow the
 * date rather than being a fixed suffix.
 */
describe("market directory spot time", () => {
  const SUMMER = Date.UTC(2026, 8, 21, 20, 0, 0) / 1000; // 16:00 New York, EDT
  const WINTER = Date.UTC(2026, 0, 21, 21, 0, 0) / 1000; // 16:00 New York, EST

  it("renders the feed time in New York, naming EDT or EST by the date", () => {
    const summer = renderToStaticMarkup(createElement(MarketDirectoryCard, { market: { ...base, spotUpdatedAt: SUMMER } }));
    const winter = renderToStaticMarkup(createElement(MarketDirectoryCard, { market: { ...base, spotUpdatedAt: WINTER } }));
    expect(summer).toContain("Sep 21, 2026, 4:00 PM EDT");
    expect(winter).toContain("Jan 21, 2026, 4:00 PM EST");
  });
});
