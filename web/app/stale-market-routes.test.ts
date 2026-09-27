/**
 *
 * A bookmarked or indexed URL for a removed market must 404 cleanly, not render a half-market page. The removed
 * tickers are READ from the registry's own `skipped` record (build-markets.mjs writes every feed the launch set
 * left out there, with that reason), so this list cannot drift from what the builder actually cut.
 *
 * Each per-market route is static (`dynamicParams = false`), so Next never renders a ticker outside
 * `generateStaticParams()`; the page body's `notFound()` is the second guard for a ticker that reaches it anyway.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { v2Markets } from "@/lib/markets";
import { parseV2Ticker } from "@/app/v2-route-params";
import * as earnPage from "@/app/earn/[ticker]/page";
import * as housePage from "@/app/house/[ticker]/page";
import * as sellPage from "@/app/sell/[ticker]/page";
import * as tickerPage from "@/app/[ticker]/page";

const registry = JSON.parse(readFileSync(fileURLToPath(new URL("../../ops/markets/tier1.json", import.meta.url)), "utf8")) as {
  launchSet: { markets: string[] };
  skipped: Array<{ ticker?: string; why: string }>;
};
const removed = registry.skipped.filter((s) => s.why.startsWith("not in launchSet.markets")).map((s) => s.ticker!);
const launch = [...registry.launchSet.markets].sort();

// /sell/[ticker] is the writer page; /earn/[ticker] is now only its redirect, and still 404s a removed ticker.
const PAGES = { "/[ticker]": tickerPage, "/sell/[ticker]": sellPage, "/earn/[ticker]": earnPage, "/house/[ticker]": housePage } as const;

/** next/navigation notFound() throws an error whose digest names the 404 fallback. */
async function status404(render: () => Promise<unknown>): Promise<boolean> {
  try {
    await render();
    return false;
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    return digest.includes("404") || digest === "NEXT_NOT_FOUND";
  }
}

describe("a removed market's URL is a clean 404", () => {
  const before = process.env.NEXT_PUBLIC_V2;
  beforeAll(() => {
    process.env.NEXT_PUBLIC_V2 = "1";
  });
  afterAll(() => {
    process.env.NEXT_PUBLIC_V2 = before;
  });

  it("the registry recorded the removed markets, and the app offers exactly the launch set", () => {
    expect(removed.length).toBeGreaterThan(0);
    expect(v2Markets().map((m) => m.ticker).sort()).toEqual(launch);
    for (const ticker of removed) expect(launch).not.toContain(ticker);
  });

  for (const [route, page] of Object.entries(PAGES)) {
    it(`${route}: static params are the launch set only, and every removed ticker 404s`, async () => {
      expect(page.dynamicParams).toBe(false);
      expect(page.generateStaticParams().map((p) => p.ticker).sort()).toEqual(launch.map((t) => t.toLowerCase()));
      for (const ticker of removed) {
        const slug = ticker.toLowerCase();
        expect(parseV2Ticker(slug), slug).toBeUndefined();
        expect(await status404(() => page.default({ params: Promise.resolve({ ticker: slug }) })), `${route} ${slug}`).toBe(true);
      }
    });
  }

  it("positive control: a launch ticker does not 404 on the market page", async () => {
    expect(await status404(() => tickerPage.default({ params: Promise.resolve({ ticker: "nvda" }) }))).toBe(false);
  });
});
