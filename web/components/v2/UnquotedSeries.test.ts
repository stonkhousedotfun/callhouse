/**
 * UnquotedSeries: the marketplace's "listed, waiting on a maker" tiles. They must say what exists and must
 * never read as buyable: no ask, no multiple, no buy control. Rendered with the series feed mocked.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketSeriesResponse } from "@/lib/v2/api-types";

const feed = vi.hoisted(() => ({
  state: { data: undefined as MarketSeriesResponse | undefined, isError: false },
  calls: [] as unknown[][],
}));
vi.mock("@/lib/v2/hooks", () => ({
  useMarketSeries: (...args: unknown[]) => { feed.calls.push(args); return feed.state; },
}));

import { UnquotedSeries } from "./UnquotedSeries";

const fixture = JSON.parse(readFileSync(fileURLToPath(
  new URL("../../../ops/fixtures/api/v2/markets/NVDA/series.json", import.meta.url)), "utf8")) as MarketSeriesResponse;
const [first] = fixture.items;
const item = (longId: string, isPut: boolean, strike: string) =>
  ({ ...first!, series: { ...first!.series, longId, isPut, strike: { ...first!.series.strike, formatted: strike } } });

const render = (ticker: string | undefined, type: "call" | "put" = "call") =>
  renderToStaticMarkup(createElement(UnquotedSeries, { ticker, type }));

beforeEach(() => { feed.state = { data: undefined, isError: false }; feed.calls = []; });

describe("UnquotedSeries", () => {
  it("asks the feed for at most five series of the requested type", () => {
    render("NVDA", "put");
    expect(feed.calls[0]).toEqual(["NVDA", { limit: 5, type: "put" }]);
  });

  it("renders nothing with no ticker, a failed feed, a pending feed or an empty ladder", () => {
    feed.state = { data: fixture, isError: false };
    expect(render(undefined)).toBe("");
    feed.state = { data: fixture, isError: true };
    expect(render("NVDA")).toBe("");
    feed.state = { data: undefined, isError: false };
    expect(render("NVDA")).toBe("");
    feed.state = { data: { ...fixture, items: [] }, isError: false };
    expect(render("NVDA")).toBe("");
  });

  it("names each contract, its expiry and links to its page, with no price and no buy control", () => {
    feed.state = { data: { ...fixture, items: [item("11", false, "210"), item("22", true, "180.5")] }, isError: false };
    const html = render("NVDA");
    expect(html).toContain("Listed, waiting on a maker");
    expect(html).toContain("These NVDA contracts exist on chain.");
    expect(html).toContain("NVDA 210 call");
    expect(html).toContain("NVDA 180.5 put");
    expect(html).toContain('href="/nvda/11"');
    expect(html).toContain('href="/nvda/22"');
    expect(html).toContain(`dateTime="${new Date(first!.series.expiry * 1000).toISOString()}"`);
    expect(html.match(/No ask yet/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button|Buy|USDG|×/);
  });

  it("never shows more than five even if the feed returns more", () => {
    const many = Array.from({ length: 8 }, (_, i) => item(String(i), false, String(100 + i)));
    feed.state = { data: { ...fixture, items: many }, isError: false };
    const html = render("NVDA");
    expect(html.match(/<li /g)).toHaveLength(5);
    expect(html).toContain('href="/nvda/4"');
    expect(html).not.toContain('href="/nvda/5"');
  });
});
