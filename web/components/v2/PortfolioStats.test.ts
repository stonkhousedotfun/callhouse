import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HistoryItem } from "@/lib/v2/api-types";
import { summariseHistory } from "@/lib/v2/historySummary";
import { PortfolioHero, PortfolioStatTiles } from "./PortfolioStats";

const usdg = (raw: string) => ({ raw, decimals: 6, formatted: (Number(raw) / 1e6).toString() });
const fill = (id: string, ts: number, pnl: string) => ({ id, kind: "fill", ts, longId: "1", series: null,
  data: { premium: usdg("1000000"), fee: usdg("100000"), rebate: usdg("0"), tx: "0x00", realisedPnl: usdg(pnl) } }) as unknown as HistoryItem;
const NOW = 1_800_000_000;
const DAY = 86_400;

describe("Portfolio hero", () => {
  const items = [fill("a", NOW - 20 * DAY, "3000000"), fill("b", NOW - 2 * DAY, "-1000000")];
  const hero = (props: Partial<Parameters<typeof PortfolioHero>[0]> = {}) => renderToStaticMarkup(createElement(PortfolioHero, {
    items, realisedUsdg: summariseHistory(items, undefined).realisedUsdg, period: "1M", onPeriod: () => {}, now: NOW, ...props }));

  it("shows the wallet's realised total and this week's delta, never the mockup's illustrative figures", () => {
    const html = hero();
    expect(html).toContain("Realised P&amp;L · USDG value");
    expect(html).toMatch(/data-slot="pnl-hero"[^>]*>\+2</);
    expect(html).toContain("−1</span> <span class=\"font-medium text-ink-3\">this week");
    expect(html).not.toContain("12.40");
    expect(html).not.toContain("4.62");
  });

  it("draws the line for the period and labels it, with a 1W / 1M / All control", () => {
    const html = hero();
    expect(html).toContain('aria-label="Realised P and L over the last month"');
    expect(html).toMatch(/<polyline[^>]*points="[\d., ]+"/);
    for (const period of ["1W", "1M", "All"]) expect(html).toContain(`>${period}</button>`);
    expect(html).toContain('aria-pressed="true"');
  });

  it("shows the designed empty state when the period has no realised P&L, and a loading state before the clock", () => {
    const empty = hero({ items: [], realisedUsdg: 0n });
    expect(empty).toContain('data-slot="pnl-empty"');
    expect(empty).not.toContain("<polyline");
    expect(empty).toContain("No realised P&amp;L in this period yet");
    expect(hero({ now: null })).toContain("Loading your realised P&amp;L");
  });

  it("colours a net loss as a loss", () => {
    const loss = [fill("a", NOW - DAY, "-2500000")];
    // display money through fmtUsdg (rules), so cents show.
    expect(hero({ items: loss, realisedUsdg: -2_500_000n })).toMatch(/data-slot="pnl-hero" class="[^"]*text-danger-text[^"]*">−2\.50</);
  });
});

describe("Portfolio history strip", () => {
  it("renders net maker premium, fees paid and fill rebates from the summary, one cell each", () => {
    const summary = summariseHistory([fill("a", NOW, "3000000")], undefined);
    const html = renderToStaticMarkup(createElement(PortfolioStatTiles, { summary }));
    for (const label of ["Net maker premium", "Fees paid", "Fill rebates"]) expect(html).toContain(label);
    expect(html).not.toContain("Realised P&amp;L");
    expect(html.match(/data-tile="stat"/g)).toHaveLength(3);
    expect(html).not.toContain("View rows");
    expect(html).toMatch(/Fills (<!-- -->)?0\.10/); // "Attributable USDG fees paid:" moved into the tile's "?"
    expect(html).toMatch(/data-slot="stat-value"[^>]*>0\.10(<!-- -->)? <small[^>]*>USDG<\/small>/);
  });

  it("the realised figure's explanation is the hero's \"?\"", () => {
    const html = renderToStaticMarkup(createElement(PortfolioHero, {
      items: [], realisedUsdg: 3_000_000n, period: "1M", onPeriod: () => {}, now: NOW }));
    expect(html).toContain("not necessarily USDG received");
    expect(html).toContain("Net maker premium is a separate figure; do not add it to P&amp;L.");
  });
});

/**
 * The fee tile names put mints only while a live market enables puts, gated on the
 * caller's `putTickers(markets.data).size > 0` exactly as gated the vaults index and payout explainer.
 */
describe("Portfolio fee tile put copy", () => {
  const summary = { ...summariseHistory([fill("a", NOW, "3000000")], undefined), mintFeesUsdg: 250_000n };

  it("puts off (the default): the tile names fills only", () => {
    for (const html of [
      renderToStaticMarkup(createElement(PortfolioStatTiles, { summary })),
      renderToStaticMarkup(createElement(PortfolioStatTiles, { summary, anyPuts: false })),
    ]) {
      expect(html).toMatch(/Fills (<!-- -->)?0\.10/);
      expect(html).not.toMatch(/put/i);
    }
  });

  it("puts on: the put mints amount returns unchanged", () => {
    const html = renderToStaticMarkup(createElement(PortfolioStatTiles, { summary, anyPuts: true }));
    expect(html).toMatch(/Fills (<!-- -->)?0\.10/);
    expect(html).toMatch(/ · put mints (<!-- -->)?0\.25/);
  });
});
