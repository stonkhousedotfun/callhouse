/**
 * The Buy home. Replaces the tests of `heroFallbackReason`, which went with the hero PayoffCard: the
 * Neon hero is the launch markets' ticker cards, so there is no featured option and
 * no fallback banner to word. The maths lives in lib/v2/buyHome.test.ts; this file pins what the page prints.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseUnits } from "viem";
import { describe, expect, it } from "vitest";


import {
  TickerCards, cardPriceView, defaultMarket, putTickers,
} from "./Marketplace";

/** Wire money as the indexer sends it: `formatted` is formatUnits, so it can carry up to six decimals. */
const usd = (dollars: string) => ({ raw: parseUnits(dollars, 6).toString(), decimals: 6, formatted: dollars });

describe("ticker cards show real reads only", () => {
  it("prints the oracle spot, and no illustrative day change", () => {
    const html = renderToStaticMarkup(createElement(TickerCards, { cards: [
      { ticker: "NVDA", name: "NVIDIA", spot: usd("229.031234"), spotUpdatedAt: 1_790_000_000 },
      { ticker: "SPCX", name: "SpaceX", spot: null, spotUpdatedAt: null },
    ] }));
    // The spot is a price (two decimals), not the wire's six-decimal `formatted`.
    expect(html).toContain("$229.03<");
    expect(html).not.toContain("229.031234");
    expect(html).toContain("Price unavailable");
    expect(html).not.toContain("Updated");
    expect(html).not.toContain("Oracle");
    expect(html).toContain('data-ticker-logo="NVDA"');
    expect(html).toContain('data-ticker-logo="SPCX"');
    expect(html).not.toMatch(/[+−-]\d+\.\d+%/);
  });

  it("renders nothing without launch markets", () => {
    expect(renderToStaticMarkup(createElement(TickerCards, { cards: [] }))).toBe("");
  });
});

describe("no weekly or monthly filter (0DTE only)", () => {
  const source = readFileSync(resolve(import.meta.dirname, "Marketplace.tsx"), "utf8");
  // Strip comments, which explain the rule in those words.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("offers no Weekly or Monthly option and passes no tenor", () => {
    expect(code).not.toMatch(/weekly|monthly/i);
    expect(code).not.toMatch(/\btenor\b/);
  });

  it("embeds the chosen market's chain, whose chips come from that market's listed expiries", () => {
    expect(code).toContain("<MarketPage key={active} ticker={active} embedded />");
  });

  it("opens on the market with the soonest expiry, and the cards switch it", () => {
    const cards = [{ ticker: "SPCX", name: "SpaceX", spot: null, spotUpdatedAt: null }, { ticker: "NVDA", name: "NVIDIA", spot: null, spotUpdatedAt: null }];
    expect(defaultMarket([{ ticker: "SPCX", expiries: [300] }, { ticker: "NVDA", expiries: [100, 400] }], cards)).toBe("NVDA");
    expect(defaultMarket([], [])).toBeNull();
    const html = renderToStaticMarkup(createElement(TickerCards, { cards, selected: "NVDA", onSelect: () => {} }));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).not.toMatch(/<a /);
  });
});

describe("put surfaces follow each market's registry puts flag", () => {
  const source = readFileSync(resolve(import.meta.dirname, "Marketplace.tsx"), "utf8");

  it("puts:false on every market: calls-only copy", () => {
    const puts = putTickers([{ ticker: "NVDA", puts: false, status: "live" }, { ticker: "SPCX", puts: false, status: "live" }]);
    expect(puts.size).toBe(0);
  });

  it("puts:true on one market: the copy comes back, and only that market is a put market", () => {
    const puts = putTickers([{ ticker: "NVDA", puts: true, status: "live" }, { ticker: "SPCX", puts: false, status: "live" }]);
    expect([...puts]).toEqual(["NVDA"]);
  });


  it("markets still loading (no data) show no put surface", () => {
    expect(putTickers(undefined).size).toBe(0);
  });

  it("puts:true on a market that is not live offers no put surface", () => {
    expect(putTickers([{ ticker: "NVDA", puts: true, status: "planned" }, { ticker: "SPCX", puts: true, status: "paused" }]).size).toBe(0);
    expect([...putTickers([{ ticker: "NVDA", puts: true, status: "paused" }, { ticker: "SPCX", puts: true, status: "live" }])]).toEqual(["SPCX"]);
  });

  it("the page wires the flag through, not a literal", () => {
    expect(source).not.toContain("fees included");
  });
});

/* A ticker card always shows a price when anything has one, with where it came from. */
describe("ticker cards fall back to a display price", () => {
  const nvda = { ticker: "NVDA", name: "NVIDIA", spot: null, spotUpdatedAt: null };
  const fallback = { raw: 225_549_701n, updatedAt: 1_790_186_399, source: "chainlink" as const };

  it("uses the fallback with a plain source line when the API has no spot", () => {
    const view = cardPriceView(nvda, fallback, 1_790_223_000, "America/New_York");
    expect(view.price).toBe("$225.54");
    expect(view.fallbackLine).toBe("Last close price, updated Sep 23, 1:59 PM EDT");
    // The reader's zone, named.
    expect(cardPriceView(nvda, fallback, 1_790_223_000, "America/Los_Angeles").fallbackLine)
      .toBe("Last close price, updated Sep 23, 10:59 AM PDT");
    // A server render cannot know the reader's zone, so it is New York, zone named (components/ui/Time.tsx).
    const html = renderToStaticMarkup(createElement(TickerCards, { cards: [nvda], fallback: new Map([["NVDA", fallback]]) }));
    expect(html).toContain("$225.54");
    expect(html).toContain("Last close price, updated Sep 23, 1:59 PM EDT");
    expect(html).not.toContain("UTC");
    expect(html).not.toContain("Price unavailable");
  });

  it("keeps the API spot and its time when it has one, and says unavailable only when nothing does", () => {
    expect(cardPriceView({ ...nvda, spot: usd("229.031234"), spotUpdatedAt: 1_790_000_000 }, fallback, 1_790_223_000, "America/New_York"))
      .toEqual({ price: "$229.03", fallbackLine: null });
    expect(cardPriceView(nvda, undefined, 1_790_223_000, "America/New_York")).toEqual({ price: "Price unavailable", fallbackLine: null });
  });
});
