/**
 * LegacyHome (the v1 app home, `/` when NEXT_PUBLIC_V2 is not "1"): one card per LIVE market linking its account and
 * book and its factory on the explorer, the live count in words, and the "Next" card only while planned markets
 * remain, each wave under its label (a paused market's wave "live" reads "Paused", never "Live").
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import LegacyHome from "./LegacyHome";

const M = vi.hoisted(() => ({ markets: null as unknown[] | null, planned: null as unknown[] | null }));
vi.mock("@/lib/markets", async (orig) => {
  const real = await orig<typeof import("@/lib/markets")>();
  return {
    ...real,
    get MARKETS() { return M.markets ?? real.MARKETS; },
    plannedByWave: () => M.planned ?? real.plannedByWave(),
  };
});

const F = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const market = (ticker: string, n: number) => ({ ticker, name: `${ticker} Inc.`, factory: F(n), asset: F(n + 100) });
const html = () => renderToStaticMarkup(createElement(LegacyHome));
const text = () => html().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const hrefs = () => [...html().matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

beforeEach(() => {
  M.markets = null;
  M.planned = null;
});

describe("LegacyHome", () => {
  it("the compiled registry: one live market, named; no Next card when nothing is planned", () => {
    const t = text();
    expect(t).toContain("NVDA now.");
    expect(t).toContain("One market.");
    expect(t).not.toContain("more, not open yet.");
    expect(hrefs()).toEqual(expect.arrayContaining(["/nvda/account", "/nvda/book", "/docs"]));
  });

  it("two live markets read 'A and B'; three or more are counted", () => {
    M.markets = [market("NVDA", 1), market("TSLA", 2)];
    expect(text()).toContain("NVDA and TSLA now.");
    expect(text()).toContain("2 markets.");
    M.markets = [market("NVDA", 1), market("TSLA", 2), market("AAPL", 3)];
    expect(text()).toContain("3 stocks now.");
  });

  it("each card links that market's account, book and factory on the explorer", () => {
    M.markets = [market("NVDA", 1), market("TSLA", 2)];
    const out = html();
    expect(hrefs()).toEqual(expect.arrayContaining(["/tsla/account", "/tsla/book"]));
    expect(out).toContain("Put TSLA in");
    expect(hrefs().some((h) => h!.endsWith(`/address/${F(2)}`))).toBe(true);
  });

  it("planned markets: the count, and each wave under its label; a paused market's wave says Paused", () => {
    M.planned = [
      { wave: "live", markets: [market("META", 5)] },
      { wave: "canary", markets: [market("AAPL", 3), market("MSFT", 4)] },
      { wave: "wave2", markets: [market("AMD", 6)] },
    ];
    const t = text();
    expect(t).toContain("4 more, not open yet.");
    // each chip carries a logo (a letter fallback here) before its ticker
    expect(t).toMatch(/Paused M META Next A AAPL M MSFT Later A AMD/);
    expect(html()).not.toContain(">Live</dt>");
    expect(html()).toContain(">Paused</dt>");
  });
});
