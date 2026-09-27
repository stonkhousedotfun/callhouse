/**
 * PriceChart: history with range buttons, the delay note and the source credit; the live spot
 * appended; and the session-spot fallback while loading or when the history cannot be read -- never a blank.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PriceHistoryOk, PriceRange } from "@/lib/v2/priceHistory";

import {
  PRICE_VIEW, PriceChart, PriceChartView, historySamples, historyStateOf, isStale, priceLine, type HistoryState,
} from "./PriceChart";

const s = (t: number, dollars: number) => ({ t, price: BigInt(Math.round(dollars * 1_000_000)) });

function body(range: PriceRange = "1D", overrides: Partial<PriceHistoryOk> = {}): PriceHistoryOk {
  const candles = [
    { t: 1_000, o: 228, h: 230, l: 227, c: 229 },
    { t: 1_900, o: 229, h: 231, l: 228, c: 230 },
    { t: 2_800, o: 230, h: 232, l: 229, c: 231 },
  ];
  return {
    ok: true, ticker: "NVDA", range, resolutionSec: 900, pool: "0xPOOL", candles, firstAt: 1_000, lastAt: 2_800,
    fetchedAt: 3_000, source: "GeckoTerminal", sourceUrl: "https://www.geckoterminal.com/robinhood/pools/0xPOOL", ...overrides,
  };
}

function view(history: HistoryState, range: PriceRange = "1D", samples = [s(0, 229)]): string {
  return renderToStaticMarkup(createElement(PriceChartView, { ticker: "NVDA", samples, range, onRange: () => {}, history }));
}

describe("priceLine", () => {
  it("needs two distinct times", () => {
    expect(priceLine([])).toBeNull();
    expect(priceLine([s(1, 229)])).toBeNull();
    expect(priceLine([s(1, 229), s(1, 230)])).toBeNull();
  });

  it("spans the box left to right, low price at the bottom, and ends on the latest sample", () => {
    const line = priceLine([s(30, 231), s(0, 229), s(15, 230)])!;
    const pts = line.points.split(" ").map((p) => p.split(",").map(Number));
    expect(pts[0]).toEqual([PRICE_VIEW.pad, PRICE_VIEW.height - PRICE_VIEW.pad]);
    expect(pts[2]).toEqual([PRICE_VIEW.width - PRICE_VIEW.pad, PRICE_VIEW.pad]);
    expect(line.last).toEqual({ x: PRICE_VIEW.width - PRICE_VIEW.pad, y: PRICE_VIEW.pad });
  });

  it("draws a flat price mid-height instead of on an edge", () => {
    const line = priceLine([s(0, 229), s(10, 229)])!;
    expect(line.points).toBe(`${PRICE_VIEW.pad},${PRICE_VIEW.height / 2} ${PRICE_VIEW.width - PRICE_VIEW.pad},${PRICE_VIEW.height / 2}`);
  });
});

describe("historySamples", () => {
  const candles = body().candles;

  it("draws each candle's close and appends the live spot when it is newer than the last candle", () => {
    const points = historySamples(candles, [s(100, 1), s(2_950, 231.5)]);
    expect(points.map((p) => p.t)).toEqual([1_000, 1_900, 2_800, 2_950]);
    expect(points.at(-1)!.price).toBe(231_500_000n);
    expect(points[0].price).toBe(229_000_000n);
  });

  it("leaves out a live print older than the last candle rather than drawing it out of order", () => {
    expect(historySamples(candles, [s(2_000, 250)]).map((p) => p.t)).toEqual([1_000, 1_900, 2_800]);
    expect(historySamples(candles, []).map((p) => p.t)).toEqual([1_000, 1_900, 2_800]);
  });
});

describe("isStale", () => {
  it("flags a history whose newest candle is older than one candle plus the 15-minute delay", () => {
    expect(isStale({ lastAt: 0, fetchedAt: 900 + 900, resolutionSec: 900 })).toBe(false);
    expect(isStale({ lastAt: 0, fetchedAt: 900 + 900 + 1, resolutionSec: 900 })).toBe(true);
  });
});

describe("historyStateOf", () => {
  it("is ok only for an ok body, and carries the route's own reason otherwise", () => {
    expect(historyStateOf(body(), "x")).toEqual({ status: "ok", body: body() });
    expect(historyStateOf({ ok: false, ticker: "NVDA", range: "1D", error: "The price source answered HTTP 500.", retryable: true }, "x"))
      .toEqual({ status: "error", message: "The price source answered HTTP 500." });
    expect(historyStateOf(null, "the price route answered HTTP 502.")).toEqual({ status: "error", message: "the price route answered HTTP 502." });
  });
});

describe("PriceChartView", () => {
  it("draws the history with range buttons, the delay note, the last candle's time and the source credit", () => {
    const html = view({ status: "ok", body: body() });
    expect(html).toContain('data-history="ok"');
    expect(html).toContain("<polyline");
    expect(html).toContain('aria-label="NVDA price, 1D, 15-minute candles"');
    for (const r of ["1D", "1W", "1M", "1Y"]) expect(html).toMatch(new RegExp(`>${r}</button>`));
    expect(html).toMatch(/aria-pressed="true"[^>]*>1D<\/button>/);
    expect(html).toContain("Delayed up to 15 minutes · 15-minute candles · last candle ");
    expect(html).toContain('Data: <a href="https://www.geckoterminal.com/robinhood/pools/0xPOOL"');
    expect(html).toContain(">GeckoTerminal</a>");
    // Change over the range: first open 228 to last close 231.
    expect(html).toContain("+1.32% past day");
    expect(html).not.toContain("no newer trade");
  });

  it("says so when the newest candle is old instead of passing it off as current", () => {
    expect(view({ status: "ok", body: body("1D", { fetchedAt: 2_800 + 900 + 900 + 1 }) })).toContain("no newer trade in the pool since then");
  });

  it("switches range: the selected range is pressed and the candle width follows it", () => {
    const html = view({ status: "ok", body: body("1W", { resolutionSec: 3_600 }) }, "1W");
    expect(html).toMatch(/aria-pressed="true"[^>]*>1W<\/button>/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>1D<\/button>/);
    expect(html).toContain('aria-label="NVDA price, 1W, 1-hour candles"');
    expect(html).toContain("1-hour candles · last candle");
  });

  it("falls back to the session spot with the reason when the history cannot be read -- the control", () => {
    const html = view({ status: "error", message: "The price source answered HTTP 500." }, "1D", [s(0, 229), s(15, 230)]);
    expect(html).toContain('data-history="error"');
    expect(html).toContain('aria-label="NVDA spot since this page opened"');
    expect(html).toContain("Price history is unavailable right now: The price source answered HTTP 500.");
    expect(html).not.toContain("GeckoTerminal");
    expect(html).not.toContain("Delayed up to 15 minutes");
  });

  it("never shows a blank box: with one reading and no history it says why and what it will draw", () => {
    const html = view({ status: "error", message: "The price source did not answer in time." });
    expect(html).not.toContain("<polyline");
    expect(html).toContain("Price history is unavailable right now: The price source did not answer in time.");
    expect(html).toContain("This view draws the live NVDA spot as it");
  });
});

describe("PriceChart", () => {
  it("renders the loading state first: range buttons, 1D selected, and the session fallback", () => {
    const html = renderToStaticMarkup(createElement(PriceChart, { ticker: "NVDA", samples: [s(0, 229), s(15, 230)] }));
    expect(html).toContain('data-history="loading"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>1D<\/button>/);
    expect(html).toContain('aria-label="NVDA spot since this page opened"');
    expect(html).toContain("Loading price history…");
  });
});
