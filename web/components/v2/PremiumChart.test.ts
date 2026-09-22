import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Trade } from "@/lib/v2/api-types";
import { PremiumChart } from "./PremiumChart";

function trade(id: string, ts: number, price: string, raw: string, units = "100"): Trade {
  return {
    id,
    ts,
    price: { formatted: price, raw, decimals: 6 },
    units,
    premium: { formatted: price, raw, decimals: 6 },
    takerIsBuyer: true,
    primary: false,
    taker: "0x0000000000000000000000000000000000000001",
    maker: "0x0000000000000000000000000000000000000002",
    tx: `0x${id.padStart(64, "0")}`,
  };
}

describe("premium history chart", () => {
  it("sorts trades into time order and exposes the latest fill as accessible detail", () => {
    const html = renderToStaticMarkup(createElement(PremiumChart, {
      trades: [
        trade("2", 1_700_000_200, "2.50", "2500000"),
        trade("1", 1_700_000_000, "1.25", "1250000"),
        trade("3", 1_700_000_100, "2.00", "2000000"),
      ],
      loading: false,
      error: false,
    }));

    expect(html).toContain("Premium history");
    expect(html).toContain("Option premium per share over time");
    expect(html).toContain("USDG / share");
    expect(html).toContain("Trade time · New York");
    expect(html).toContain("3 trades from");
    expect(html).toContain("Latest trade: 2.50 USDG per share");
    expect(html).toContain('role="slider"');
    expect(html).toContain("Tap or drag across the chart");
  });

  it("keeps loading, outage, empty, and one-fill states distinct", () => {
    const loading = renderToStaticMarkup(createElement(PremiumChart, { trades: [], loading: true, error: false }));
    const unavailable = renderToStaticMarkup(createElement(PremiumChart, { trades: [], loading: false, error: true }));
    const empty = renderToStaticMarkup(createElement(PremiumChart, { trades: [], loading: false, error: false }));
    const single = renderToStaticMarkup(createElement(PremiumChart, {
      trades: [trade("1", 1_700_000_000, "1.25", "1250000", "1")],
      loading: false,
      error: false,
    }));

    expect(loading).toContain("Loading premium history…");
    expect(unavailable).toContain("Premium history is temporarily unavailable.");
    expect(empty).toContain("The chart will appear after the first fill.");
    expect(single).toContain("Latest trade: 1.25 USDG per share");
    expect(single).not.toContain('role="slider"');
  });

  it("plots time left to right whatever order the API returns, and survives a flat timestamp run", () => {
    // All four fills share one second - a real burst in one block. The x positions must still be
    // distinct and increasing, or the burst collapses into a single vertical smear.
    const burst = renderToStaticMarkup(createElement(PremiumChart, {
      trades: [
        trade("a", 1_700_000_000, "1.00", "1000000"),
        trade("b", 1_700_000_000, "1.10", "1100000"),
        trade("c", 1_700_000_000, "1.20", "1200000"),
        trade("d", 1_700_000_000, "1.30", "1300000"),
      ],
      loading: false, error: false,
    }));
    // The LINE path only. The area path is drawn first and closes back along the baseline, so a
    // scan over every path in the markup is non-monotonic by construction and would prove nothing.
    const linePath = [...burst.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!).find((d) => !d.endsWith("Z"));
    expect(linePath, "the line path is present and is not the closed area path").toBeDefined();
    const xs = [...linePath!.matchAll(/[ML] ([\d.]+) [\d.]+/g)].map((match) => Number(match[1]));
    expect(xs).toHaveLength(4);
    expect(xs.slice(1).every((x, index) => x > xs[index]!)).toBe(true);
    expect(burst).toContain("Latest trade: 1.30 USDG per share");
  });

  it("drops a fill whose price cannot be read rather than plotting it at zero", () => {
    // A malformed raw amount yields NaN. Plotting it would put a fake floor on the y axis and drag
    // the whole line down; the chart must ignore it and say so in its own count.
    const broken = trade("bad", 1_700_000_050, "?", "not-a-number");
    const html = renderToStaticMarkup(createElement(PremiumChart, {
      trades: [
        trade("1", 1_700_000_000, "1.25", "1250000"),
        broken,
        trade("2", 1_700_000_100, "2.50", "2500000"),
      ],
      loading: false, error: false,
    }));
    expect(html).toContain("2 trades from");
    expect(html).toContain("Latest trade: 2.50 USDG per share");
    expect(html).not.toContain("Latest trade: ? USDG per share");
  });

  it("draws the line at the dataviz mark width and rings the latest fill against the surface", () => {
    const html = renderToStaticMarkup(createElement(PremiumChart, {
      trades: [trade("1", 1_700_000_000, "1.25", "1250000"), trade("2", 1_700_000_100, "2.50", "2500000")],
      loading: false, error: false,
    }));
    // 2px line, not 3: thin marks are the spec, and a fat line reads as an area edge.
    expect(html).toMatch(/stroke="var\(--accent\)" stroke-width="2"/);
    expect(html).toMatch(/r="5"[^>]*stroke="var\(--surface\)"/);
  });

  it("labels cached data when live updates fail", () => {
    const html = renderToStaticMarkup(createElement(PremiumChart, {
      trades: [trade("1", 1_700_000_000, "1.25", "1250000")],
      loading: false,
      error: true,
    }));
    expect(html).toContain("Live updates are unavailable. Showing saved trades.");
    expect(html).toContain("Latest trade: 1.25 USDG per share");
  });
});
