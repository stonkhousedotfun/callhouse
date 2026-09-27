/**
 * The /trust/markets page component (MarketDirectory), not just its card: how the indexer's state (loading, error,
 * ready) reaches the rows, the filter counts, the retry control, and the empty-filter panel.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Market } from "@/lib/v2/api-types";
import { useMarkets } from "@/lib/v2/hooks";
import { filterMarketDirectory } from "@/lib/v2/marketDirectory";
import { MarketDirectory } from "./MarketDirectory";

vi.mock("@/lib/v2/hooks", () => ({ useMarkets: vi.fn() }));
vi.mock("@/lib/v2/marketDirectory", async (orig) => {
  const real = await orig<typeof import("@/lib/v2/marketDirectory")>();
  return { ...real, filterMarketDirectory: vi.fn(real.filterMarketDirectory) };
});

const markets = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../ops/fixtures/api/v2/markets.json", import.meta.url)), "utf8"),
) as Market[];

function query(over: Partial<ReturnType<typeof useMarkets>>) {
  vi.mocked(useMarkets).mockReturnValue({
    data: undefined, isError: false, isFetching: false, refetch: vi.fn(), ...over,
  } as unknown as ReturnType<typeof useMarkets>);
}
const render = () => renderToStaticMarkup(createElement(MarketDirectory));

beforeEach(() => query({}));

describe("MarketDirectory page", () => {
  it("loading: every registry row is 'Checking', none is linked, and no error notice", () => {
    const html = render();
    expect(html).toContain("Market status");
    expect(html).toContain("All · 2");
    expect(html).toContain("Checking");
    expect(html).not.toContain("Live market data is unavailable.");
    expect(html).not.toContain('href="/nvda"');
    expect(vi.mocked(filterMarketDirectory)).toHaveBeenLastCalledWith(expect.any(Array), "", "all");
  });

  it("ready: NVDA (in the API, live) is linked; SPCX (registry only) is not", () => {
    query({ data: markets });
    const html = render();
    expect(html).toContain('href="/nvda"');
    expect(html).not.toContain('href="/spcx"');
    expect(html).toContain("Status unavailable");
    expect(html).not.toContain("Live market data is unavailable.");
  });

  it("error: a warning notice with a Retry, and trading links stay off", () => {
    query({ isError: true, data: markets });
    const html = render();
    expect(html).toContain("Live market data is unavailable.");
    expect(html).toContain("trading links are off until it loads");
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(html).not.toContain('href="/nvda"');
  });

  it("error while refetching: the Retry is disabled and says so", () => {
    query({ isError: true, isFetching: true });
    const html = render();
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Retrying…<\/button>/);
  });

  it("no row matches the filter: the empty panel with a way back to all", () => {
    vi.mocked(filterMarketDirectory).mockReturnValueOnce([]);
    const html = render();
    expect(html).toContain("No markets match");
    expect(html).toContain("No market is all right now.");
    expect(html).toContain("Show all markets");
  });
});
