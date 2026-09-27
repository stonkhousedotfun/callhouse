/**
 * The Neon market page. The ten-column StrikeLadder and its Simple/Pro views are gone: the Neon page
 * replaces them with selectable strike rows and a rail order summary, so the ladder's tests were retired with it and
 * the pieces that replaced them are tested here instead. formatDeltaChance is kept for the series page.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  EmptyAsks, NoExpiries, StrikeRows, TradingPausedNotice, chainBreakEven, chainQuotes, chartHeading, chartSource, chooseRow, formatDeltaChance, heroSourceLine, initialStepperShares, marketPageSpots, pageView,
  reviewHref, routeChartSeries, routeSeriesOnOtherMarket, rowCostCell, sharePriceIndex, shownRouteId, ticketSummary,
} from "./MarketPage";
import { getV2Market, v2Markets } from "@/lib/markets";
import { railPnlAt, railSummary, strikeRow, type StrikeRow } from "@/lib/v2/ticket";
import { TRADING_PAUSED_LINE } from "@/lib/v2/tradingGate";

// Launch rates, stated so the hand-checked figures stay true (spec 6.3: fee = min(0.10, 10% of premium) per share).
const launch = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const SPOT = usd(229.03);
// `askUnits` here is the units AT the best ask, which is what every case below means; it goes on the wire as
// `bestAskUnits`, with total depth (`askUnits` on the wire) equal to it, i.e. a one-level book.
const item = (longId: string, strike: string, ask: string | null, { isPut = false, askUnits = "500", expiry = 1_790_000_000 } = {}) => ({
  series: { longId, isPut, strike: { raw: String(usd(Number(strike))), formatted: strike }, expiry },
  quote: { bestAsk: ask === null ? null : { raw: String(usd(Number(ask))) }, askUnits, bestAskUnits: askUnits },
});
const row = (longId: string, strike: string, ask: string | null, opts = {}): StrikeRow =>
  strikeRow(item(longId, strike, ask, opts), launch, SPOT);

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

describe("routing helpers", () => {
  it("Review order opens the series route's ticket with the rail's size", () => {
    expect(reviewHref("NVDA", "7", 3)).toBe("/nvda/7?buy=1&shares=3");
  });

  it("the rail stepper starts from the route's shares as whole shares, at least one and at most the stepper cap", () => {
    expect(initialStepperShares(undefined)).toBe(1);
    expect(initialStepperShares("3")).toBe(3);
    expect(initialStepperShares("2.5")).toBe(2);
    expect(initialStepperShares("0.5")).toBe(1);
    expect(initialStepperShares("not a number")).toBe(1);
    expect(initialStepperShares("5000")).toBe(1_000);
  });
});

describe("pageView: the day and side on screen", () => {
  const days = [100, 200, 300];
  const none = { expiry: null, type: null };

  it("with no choice and no route series: the first listed day, calls", () => {
    expect(pageView(days, none, null, true)).toEqual({ expiry: 100, type: "call" });
  });

  it("/[ticker]/[series] opens on that series' own day and side", () => {
    expect(pageView(days, none, { expiry: 200, isPut: true }, true)).toEqual({ expiry: 200, type: "put" });
  });

  it("the reader's choice wins over the route series", () => {
    expect(pageView(days, { expiry: 300, type: "call" }, { expiry: 200, isPut: true }, true)).toEqual({ expiry: 300, type: "call" });
  });

  it("a market without puts shows calls even for a put route, and an unlisted day falls back to the first listed", () => {
    expect(pageView(days, none, { expiry: 999, isPut: true }, false)).toEqual({ expiry: 100, type: "call" });
    expect(pageView([], none, null, true).expiry).toBeUndefined();
  });
});

describe("chooseRow", () => {
  const rows = [row("1", "230", null), row("2", "236", "1.00"), row("3", "240", "0.40")];

  it("keeps the reader's pick when it is on screen", () => {
    expect(chooseRow(rows, "3", null)?.longId).toBe("3");
    expect(chooseRow(rows, "3", "2")?.longId).toBe("3");
  });

  it("on /[ticker] falls back to the first row with an ask, then the first row, then nothing", () => {
    expect(chooseRow(rows, null, null)?.longId).toBe("2");
    expect(chooseRow(rows, "gone", null)?.longId).toBe("2");
    expect(chooseRow([row("1", "230", null)], null, null)?.longId).toBe("1");
    expect(chooseRow([], null, null)).toBeNull();
  });

  it("on /[ticker]/[series] never swaps the route's series for another strike while its row is off screen", () => {
    expect(chooseRow(rows, "9", "9")).toBeNull();
    expect(chooseRow([], "9", "9")).toBeNull();
    // Once the reader moves off it (a new day or side clears the pick), the ordinary fallback applies.
    expect(chooseRow(rows, null, "9")?.longId).toBe("2");
  });
});

describe("chartSource: what the payoff chart draws", () => {
  const one = 100n;

  it("the chosen row at its best ask is a live quote: no label, the rail's cost and premium, the series' expiry", () => {
    const chosen = row("2", "236", "1.00");
    const summary = railSummary(chosen, one, launch)!;
    const source = chartSource("NVDA", chosen, null, summary, one, SPOT, launch, 1_789_000_000)!;
    expect(source.label).toBeNull();
    expect(source.input).toMatchObject({ strike: usd(236), cost: usd(1.10), premium: usd(1), expiry: 1_790_000_000, units: one });
  });

  it("binds to the ticket's own quote when the ticket is open: the ticket's cost is the cost line", () => {
    const chosen = row("2", "236", "1.00");
    const bound = ticketSummary({ longId: "2", units: 250n, cost: usd(2.75), premium: usd(2.5) });
    expect(bound.fee).toBe(usd(0.25));
    const source = chartSource("NVDA", chosen, null, bound, 250n, SPOT, launch, 1_789_000_000)!;
    expect(source.input).toMatchObject({ units: 250n, cost: usd(2.75), premium: usd(2.5) });
  });

  it("with no ask it falls back to the last trade, labelled as not a live quote", () => {
    const quiet = row("1", "230", null);
    const source = chartSource("NVDA", quiet, usd(0.8), null, one, SPOT, launch, null)!;
    expect(source.label).toBe("Last trade, not a live quote");
    expect(source.input.cost).toBe(usd(0.88)); // 0.80 + min(0.10, 0.08)
    expect(source.input.premium).toBeNull();
  });

  it("with no row at all it draws the example chart, labelled, on a whole-dollar strike about 3% above spot", () => {
    const source = chartSource("NVDA", null, null, null, one, SPOT, launch, null)!;
    expect(source.label).toBe("Not a live quote"); // The "Example" framing is gone, the warning is not
    expect(source.input.strike).toBe(usd(236)); // ceil(229.03 x 1.03 = 235.9009)
    expect(source.input.cost).toBe(usd(1.10));
  });

  it("draws nothing without the fee settings or a live spot, rather than a made-up cost", () => {
    expect(chartSource("NVDA", null, null, null, one, SPOT, null, null)).toBeNull();
    expect(chartSource("NVDA", null, null, null, one, null, launch, null)).toBeNull();
  });
});

/**
 * On /nvda/<id>?buy=1 for an expired-but-listed series the ticket said "Buy NVDA $230 call" while the chart
 * header said "Example $236.00 call": the route's row is not on screen (dayOptions keeps only future expiries), chooseRow
 * rightly refuses a stranger, and the chart fell through to the spot +3% example. The route's series is already loaded
 * (useSeriesRef), so the chart plots ITS strike and side, still labelled as an example premium.
 * Instants: 16:00 New York on Wed 2026-09-23 = 1790193600 and Fri 2026-09-25 = 1790366400; `now` = 10:00 New York on
 * Thu 2026-09-24 = 1790258400 (derived with Python's zoneinfo).
 */
describe("the route's own series while its row is off screen", () => {
  const one = 100n;
  const WED_23 = 1_790_193_600;
  const FRI_25 = 1_790_366_400;
  const NOW = 1_790_258_400;
  const route = routeChartSeries({ strike: { raw: String(usd(230)), formatted: "230" }, isPut: false, expiry: WED_23 })!;

  it("routeChartSeries reads like a strike row", () => {
    expect(route).toEqual({ label: "$230 call", strike: usd(230), isPut: false, expiry: WED_23 });
    expect(route.label).toBe(row("x", "230", null).label);
    expect(routeChartSeries(null)).toBeNull();
  });

  it("the chart input's strike and side are the route series', with the example premium still labelled", () => {
    const source = chartSource("NVDA", null, null, null, one, SPOT, launch, NOW, route)!;
    expect(source.input.strike).toBe(usd(230));
    expect(source.input.isPut).toBe(false);
    expect(source.label).toBe("Not a live quote"); // The "Example" framing is gone, the warning is not
    const put = routeChartSeries({ strike: { raw: String(usd(220)), formatted: "220" }, isPut: true, expiry: WED_23 })!;
    expect(chartSource("NVDA", null, null, null, one, SPOT, launch, NOW, put)!.input).toMatchObject({ strike: usd(220), isPut: true });
  });

  it("a chosen row still wins over the route series", () => {
    const chosen = row("2", "236", "1.00");
    const source = chartSource("NVDA", chosen, null, railSummary(chosen, one, launch)!, one, SPOT, launch, NOW, route)!;
    expect(source.input.strike).toBe(usd(236));
    expect(source.label).toBeNull();
  });

  it("the header names the route series and its OWN day, never the picker's day for a different expiry", () => {
    const source = chartSource("NVDA", null, null, null, one, SPOT, launch, NOW, route)!;
    const heading = chartHeading({ row: null, routeSeries: route, source, shares: "1", dayLabel: "Fri 25", selectedExpiry: FRI_25, now: NOW });
    expect(heading.name).toBe("$230 call");
    expect(heading.detail).not.toContain("Fri 25");
    expect(heading.detail).toBe(" · 1 sh · Wed 23 · option value by price");
    expect(heading.name).not.toContain("Example");
  });

  it("the header keeps the picker's day when the route series IS on that day, and for a chosen row or the example", () => {
    const source = chartSource("NVDA", null, null, null, one, SPOT, launch, NOW, route)!;
    expect(chartHeading({ row: null, routeSeries: route, source, shares: "1", dayLabel: "Wed 23", selectedExpiry: WED_23, now: NOW }).detail)
      .toBe(" · 1 sh · Wed 23 · option value by price");
    const chosen = row("2", "236", "1.00");
    expect(chartHeading({ row: chosen, routeSeries: null, source, shares: "2", dayLabel: "Fri 25", selectedExpiry: FRI_25, now: NOW }))
      .toEqual({ name: "$236 call", detail: " · 2 sh · Fri 25 · option value by price" });
    const example = chartSource("NVDA", null, null, null, one, SPOT, launch, null)!;
    expect(chartHeading({ row: null, routeSeries: null, source: example, shares: "1", dayLabel: "Fri 25", selectedExpiry: FRI_25, now: NOW }).name)
      .toBe("Example $236 call"); // No zero tail on a whole-dollar strike, like the strike rows
  });

  it("MarketPage feeds the off-screen route series to the chart and the header, with no price-age line", () => {
    const market = readFileSync(resolve(import.meta.dirname, "MarketPage.tsx"), "utf8");
    expect(market).toContain("selected === null && routeId !== null && selectedId === routeId ? routeChartSeries(routeSeries) : null");
    expect(market).toContain("chartSource(ticker, selected, lastPerShare, summary, units, spot, fees, now, offScreenRoute)");
    expect(market).toContain("{contractName(heading.name)}</b>{heading.detail}");
    expect(market).not.toContain("Price updated");
  });
});

describe("StrikeRows: the options chain", () => {
  const rows = [row("1", "230", null), row("2", "236", "1.00")];
  const quotes = chainQuotes([
    { ...item("1", "230", null), quote: { bestAsk: null, askUnits: "0", bestAskUnits: "0", bestBid: null, bidUnits: "0", fair: { raw: String(usd(0.8)) } } },
    { ...item("2", "236", "1.00"), quote: { bestAsk: { raw: String(usd(1)) }, askUnits: "500", bestAskUnits: "500", bestBid: { raw: String(usd(0.9)) }, bidUnits: "30", fair: null } },
  ] as never);
  const html = renderToStaticMarkup(createElement(StrikeRows, { rows, selected: "2", onSelect: () => {}, quotes, spot: SPOT, fees: launch, ticker: "NVDA" }));

  it("names each contract and prices it once: the best ask per share, in dollars, with the size for sale", () => {
    expect(html).toMatch(/>\$236<\/span> Call</);
    expect(html).toMatch(/data-slot="price"[^>]*>\$1\.00</);
    expect(html).toContain("5 sh");
    expect(html).toMatch(/Breakeven <span class="num">\+3\.5%<\/span>/);
    expect(html).not.toContain("$237.10");
    expect(html).not.toContain("To breakeven");
  });

  it("has no multiple column and no per-share max-loss label", () => {
    expect(html).not.toContain("If +10%");
    expect(html).not.toContain("max loss / sh");
  });

  it("with no ask shows the fair value marked Est. (No ask without one), and draws the share price line between the strikes", () => {
    expect(html).toMatch(/data-slot="price"[^>]*>\$0\.80</);
    expect(html).toContain(">Est.<");
    expect(renderToStaticMarkup(createElement(StrikeRows, { rows, selected: null, onSelect: () => {} }))).toContain("No ask");
    const between = renderToStaticMarkup(createElement(StrikeRows, { rows, selected: "2", onSelect: () => {}, quotes, spot: usd(233), fees: launch, ticker: "NVDA" }));
    const line = between.indexOf('data-slot="share-price"');
    expect(line).toBeGreaterThan(between.indexOf('data-long-id="1"'));
    expect(line).toBeLessThan(between.indexOf('data-long-id="2"'));
    expect(between).toContain("Share price $233.00");
    expect(html.indexOf('data-slot="share-price"')).toBeLessThan(html.indexOf('data-long-id="1"'));
  });

  it("marks exactly the chosen row", () => {
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('data-long-id="2"');
  });

  it("Sell shows the mark, never a bid, and each row picks its strike for the sell ticket", () => {
    const sell = renderToStaticMarkup(createElement(StrikeRows, { rows, selected: "2", onSelect: () => {}, quotes, spot: SPOT, fees: launch, ticker: "NVDA", side: "sell" }));
    expect(sell).not.toContain("href=");
    expect(sell).toMatch(/<button type="button" aria-pressed="true" aria-label="Sell NVDA \$236 call" data-long-id="2"/);
    expect(sell.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(sell).toMatch(/data-slot="price"[^>]*>\$0\.80</);
    expect(sell).not.toContain("$0.90");
    expect(sell.match(/>Mark</g)).toHaveLength(2);
  });

  it("puts the share price line where the price sits among the strikes", () => {
    expect(sharePriceIndex(rows, usd(233))).toBe(1);
    expect(sharePriceIndex(rows, usd(300))).toBe(2);
    expect(sharePriceIndex(rows, usd(1))).toBe(0);
    expect(sharePriceIndex(rows, null)).toBe(-1);
  });

  it("estimates breakeven from one share at the best ask, or at the fair value on the price tick", () => {
    const under = row("3", "230", "0.50", { askUnits: "40" });
    expect(chainBreakEven(under, null, launch)).toBe(railSummary(under, 100n, launch)!.breakEven);
    const empty = row("4", "230", null);
    expect(chainBreakEven(empty, 800_050n, launch)).toBe(railSummary({ ...empty, ask: 800_000n }, 100n, launch)!.breakEven);
    expect(chainBreakEven(row("5", "236", "1.00"), 1n, launch)).toBe(row("5", "236", "1.00").breakEven);
    expect(chainBreakEven(row("4", "230", null), null, launch)).toBeNull();
    expect(chainBreakEven(row("4", "230", null), 800_050n, null)).toBeNull();
  });

  // The ask bubble is a book price. Asks of 0.3989 and 0.3997 both read $0.40 when rounded up to the cent, so a
  // buyer could not tell them apart and would see each as dearer than it is. The fair-value "Est." without an ask is a
  // model value and keeps rounding up to the cent.
  it("two asks that differ only past the cents read differently; a fair estimate still rounds up to the cent", () => {
    const tight = [row("3", "236", "0.3989"), row("4", "238", "0.3997")];
    const out = renderToStaticMarkup(createElement(StrikeRows, { rows: tight, selected: null, onSelect: () => {}, spot: SPOT, fees: launch, ticker: "NVDA" }));
    const pills = [...out.matchAll(/data-slot="price"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(pills).toEqual(["$0.3989", "$0.3997"]);
    expect(out).not.toContain("$0.40");
    const est = chainQuotes([{ ...item("5", "240", null), quote: { bestAsk: null, askUnits: "0", bestAskUnits: "0", bestBid: null, bidUnits: "0", fair: { raw: String(usd(0.3989)) } } }] as never);
    const noAsk = renderToStaticMarkup(createElement(StrikeRows, { rows: [row("5", "240", null)], selected: null, onSelect: () => {}, quotes: est, spot: SPOT, fees: launch, ticker: "NVDA" }));
    expect(noAsk).toMatch(/data-slot="price"[^>]*>\$0\.40</);
    expect(noAsk).toContain(">Est.<");
  });
});

describe("EmptyAsks", () => {
  it("names the day and offers Get notified and Sell options (/sell, which was See Earn at /earn)", () => {
    const html = renderToStaticMarkup(createElement(EmptyAsks, { ticker: "NVDA", dayLabel: "Fri 25", typeWord: "Calls", listed: true }));
    expect(html).toContain("No asks for Fri 25 yet");
    expect(html).toContain('href="/settings/notifications"');
    expect(html).toContain("Get notified");
    expect(html).toContain('href="/sell/nvda"');
    expect(html).toContain(">Sell options<");
    expect(html).not.toContain("See Earn");
  });

  it("nothing listed for the day says so, with the same two actions", () => {
    const html = renderToStaticMarkup(createElement(EmptyAsks, { ticker: "NVDA", dayLabel: "Wed 23", typeWord: "Puts", listed: false }));
    expect(html).toContain("No asks for Wed 23 yet");
    expect(html).toContain("No NVDA puts are listed for this day.");
    expect(html).toContain('href="/settings/notifications"');
    expect(html).toContain('href="/sell/nvda"');
  });

  it("today is lowercased mid-sentence, and a missing day still reads as a sentence", () => {
    const today = renderToStaticMarkup(createElement(EmptyAsks, { ticker: "NVDA", dayLabel: "Today", typeWord: "Calls", listed: true }));
    expect(today).toContain("No asks for today yet");
    expect(today).not.toContain("No asks for Today yet");
    const none = renderToStaticMarkup(createElement(EmptyAsks, { ticker: "NVDA", dayLabel: null, typeWord: "Calls", listed: true }));
    expect(none).toContain("No asks for this day yet");
  });
});

describe("NoExpiries", () => {
  it("a market with nothing listed still offers Get notified and Sell options", () => {
    const html = renderToStaticMarkup(createElement(NoExpiries, { ticker: "SPCX" }));
    expect(html).toContain("No expiries are open for SPCX yet");
    expect(html).toContain('href="/settings/notifications"');
    expect(html).toContain('href="/sell/spcx"');
    expect(html).not.toMatch(/weekly|monthly/i);
  });
});

describe("one page, two routes", () => {
  const page = readFileSync(resolve(import.meta.dirname, "../../app/[ticker]/[series]/page.tsx"), "utf8");
  const market = readFileSync(resolve(import.meta.dirname, "MarketPage.tsx"), "utf8");

  it("/[ticker]/[series] renders the Neon market page with the route's series, size and ?buy=1", () => {
    expect(page).toContain('<MarketPage ticker={market.ticker} longId={id} initialShares={initialShares} openTicket={query.buy === "1"} />');
    expect(page).not.toContain("SeriesView");
  });

  it("the rail holds the real ticket for the chosen strike, bound to the chart handle; ?buy=1 only focuses it", () => {
    expect(market).toContain("ticketId !== null ? <SeriesRail ticker={ticker} longId={ticketId} openTicket={openTicket}");
    expect(market).toContain("atPrice={atPrice} onQuote={setTicketQuote} />");
    expect(market).toContain("ticketQuote?.longId === ticketId ? ticketQuote : null");
    expect(market).toContain("const ticketId = routeId === null ? selected?.longId ?? null : seriesId;");
  });
});

describe("a put link on a market without puts", () => {
  const source = readFileSync(resolve(import.meta.dirname, "MarketPage.tsx"), "utf8");

  it("puts:false: the route's put series is hidden, so no rail, ticket or details are built for it", () => {
    expect(shownRouteId("42", { isPut: true }, false)).toBeNull();
    // With the route hidden the page falls back to that day's calls: first row with an ask.
    const rows = [row("1", "230", null), row("2", "236", "1.00")];
    expect(chooseRow(rows, "42", shownRouteId("42", { isPut: true }, false))?.longId).toBe("2");
    expect(pageView([100], { expiry: null, type: null }, { expiry: 100, isPut: true }, false).type).toBe("call");
  });

  it("puts:true: the route's put series is shown and opens on puts", () => {
    expect(shownRouteId("42", { isPut: true }, true)).toBe("42");
    expect(pageView([100], { expiry: null, type: null }, { expiry: 100, isPut: true }, true).type).toBe("put");
  });

  it("a call series always shows, and an unresolved series or market keeps the route (no bounce while loading)", () => {
    expect(shownRouteId("42", { isPut: false }, false)).toBe("42");
    expect(shownRouteId("42", null, false)).toBe("42");
    expect(shownRouteId("42", { isPut: true }, undefined)).toBe("42");
    expect(shownRouteId(null, { isPut: true }, false)).toBeNull();
  });

  it("with the market list unavailable, the compiled registry's flag still hides a launch market's put route", () => {
    const registry = getV2Market(v2Markets()[0]!.ticker)?.v2.puts;
    expect(registry).toBe(false);
    expect(shownRouteId("42", { isPut: true }, registry)).toBeNull();
  });

  it("the page gates the Calls | Puts control and the route on the flag, and moves a hidden put link to /[ticker]", () => {
    expect(source).toContain("const supportsPuts = market?.puts === true;");
    expect(source).toContain('{supportsPuts ? <SegmentedControl label="Option type" selected={activeType}');
    // The other-market check sits in front of the put check; both must stay on the route.
    expect(source).toContain("const routeId = foreignRoute ? null : shownRouteId(requestedId, routeSeries, market?.puts ?? getV2Market(ticker)?.v2.puts);");
    expect(source).toContain("const foreignRoute = routeSeriesOnOtherMarket(routeSeries, ticker);");
    expect(source).toContain("const path = `/${ticker.toLowerCase()}`;");
  });
});

describe("the route's series must belong to this market", () => {
  const nvda = { ticker: "NVDA" };
  it("a series of another market is flagged, whatever the case of the route", () => {
    expect(routeSeriesOnOtherMarket(nvda, "SPCX")).toBe(true);
    expect(routeSeriesOnOtherMarket(nvda, "spcx")).toBe(true);
  });
  it("this market's own series, or one still loading, is not", () => {
    expect(routeSeriesOnOtherMarket(nvda, "NVDA")).toBe(false);
    expect(routeSeriesOnOtherMarket(nvda, "nvda")).toBe(false);
    expect(routeSeriesOnOtherMarket(null, "SPCX")).toBe(false);
  });
});

describe("a strike row says No ask only when there is no ask", () => {
  it("prices a row with a whole share on offer", () => {
    expect(rowCostCell(row("1", "230", "0.50"))).toBe("cost");
  });
  it("no ask is No ask", () => {
    expect(rowCostCell(row("1", "230", null))).toBe("no-ask");
  });
  it("an ask under one share is not No ask", () => {
    expect(rowCostCell(row("1", "230", "0.50", { askUnits: "40" }))).toBe("under-one-share");
    const html = renderToStaticMarkup(createElement(StrikeRows, { rows: [row("1", "230", "0.50", { askUnits: "40" })], selected: null, onSelect: () => {} }));
    expect(html).toMatch(/data-slot="price"[^>]*>\$0\.50</);
    expect(html).toContain("for sale");
    expect(html).not.toContain("No ask");
  });
  it("an ask without fee parameters is an unknown cost, not No ask", () => {
    const noFees = strikeRow(item("1", "230", "0.50"), null, SPOT);
    expect(rowCostCell(noFees)).toBe("unknown");
    const html = renderToStaticMarkup(createElement(StrikeRows, { rows: [noFees], selected: null, onSelect: () => {} }));
    expect(html).not.toContain("No ask");
  });
});

/*
 * The hero shows the display fallback; the rows, the chart source and the ticket read `trade`, the strict live
 * spot, which stays null when the API has none.
 */
describe("the hero's display price never becomes the page's trade spot", () => {
  const fallback = { raw: 225_549_701n, updatedAt: 1_790_186_399, source: "chainlink" as const };

  it("with no API spot: the hero has the fallback, the trade spot is null", () => {
    const { trade, display } = marketPageSpots(null, null, fallback);
    expect(trade, "the display fallback leaked into the trade spot").toBeNull();
    expect(display).toEqual(fallback);
  });

  it("with an API spot: both are that spot, as before", () => {
    const { trade, display } = marketPageSpots({ raw: "225549701" }, 1_790_223_000, fallback);
    expect(trade).toBe(225_549_701n);
    expect(display).toEqual({ raw: 225_549_701n, updatedAt: 1_790_223_000, source: "api" });
  });

  it("the hero line names the source and the time, in the zone it is given", () => {
    const NY = "America/New_York";
    expect(heroSourceLine(fallback, 1_790_223_000, NY)).toBe("Last close price, updated Sep 23, 1:59 PM EDT.");
    expect(heroSourceLine({ ...fallback, source: "pool", updatedAt: 1_790_223_000 }, null, NY)).toBe("Pool price, updated 12:10 AM EDT.");
    // The reader's zone, named; never UTC.
    expect(heroSourceLine({ ...fallback, source: "pool", updatedAt: 1_790_223_000 }, null, "America/Los_Angeles"))
      .toBe("Pool price, updated 9:10 PM PDT.");
  });

  it("before the page's clock is set (now null), an old Chainlink price is dated, not shown as current", () => {
    // It used to be measured against its own time (age 0): "Updated 1:59 PM EDT.", which reads as current.
    expect(heroSourceLine(fallback, null, "America/New_York")).toBe("Updated Sep 23, 1:59 PM EDT.");
  });
});

describe("the trading brake's notice on the market and series page", () => {
  const notice = (market: Parameters<typeof TradingPausedNotice>[0]["market"]) =>
    renderToStaticMarkup(createElement(TradingPausedNotice, { market }));

  it("shows the brake's line, as a status, when the served market reads tradingPaused", () => {
    const html = notice({ tradingPaused: true });
    expect(html).toContain('data-slot="trading-paused-notice"');
    expect(html).toContain('role="status"');
    expect(html).toContain(TRADING_PAUSED_LINE);
    expect(html).toContain("You can still cancel your open orders, close matched positions and collect payouts.");
  });

  it("shows nothing when trading is open, or when the market list is unread (the click still asks the chain)", () => {
    expect(notice({ tradingPaused: false })).toBe("");
    expect(notice(undefined)).toBe("");
    expect(notice(null)).toBe("");
  });

  it("MarketPage renders it in the page body from the served market, for /[ticker] and /[ticker]/[series] alike", () => {
    const page = readFileSync(resolve(import.meta.dirname, "MarketPage.tsx"), "utf8");
    const main = page.slice(page.indexOf("const main = <div"), page.indexOf("const rail = <div"));
    expect(main).toContain("<TradingPausedNotice market={market} />");
    expect(page).toContain("const market = markets.data?.find((item) => item.ticker === ticker);");
  });
});
