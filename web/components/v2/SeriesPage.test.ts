import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import type { SeriesDetailResponse } from "@/lib/v2/api-types";
import { SeriesFacts } from "./SeriesPage";

describe("single-series activity hierarchy", () => {
  it("puts the premium chart before the demoted book and keeps the trade table below it", () => {
    const source = readFileSync(resolve(import.meta.dirname, "SeriesPage.tsx"), "utf8");
    const chart = source.indexOf("<PremiumChart");
    const orderBook = source.indexOf("<OrderBook", chart);
    const tradeTable = source.indexOf('aria-label="Recent trades"', orderBook);

    expect(chart).toBeGreaterThan(-1);
    expect(orderBook).toBeGreaterThan(chart);
    expect(tradeTable).toBeGreaterThan(orderBook);
    expect(source).toContain("trades={trades.data?.items ?? []}");
  });
});

/**
 * T-431: the series facts print expiry and cutoff through the shared `stamp()`, not the local `ET`
 * formatter this file carried. Same New York wall-clock time on each side of the daylight-saving
 * change: a formatter that lost its zone would print 8:00 PM / 9:00 PM on a UTC runner, and a
 * hard-coded suffix would name the wrong zone for half the year.
 *
 * The "Your local time" row is deliberately the reader's zone and is filled in an effect, so a
 * server render shows "Loading…" there; that row is not a New York formatter and is not changed.
 */
const detail = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../ops/fixtures/api/v2/series/103958645695364239832519143371390703150538693767596812376310949450919320284464.json",
  import.meta.url)), "utf8")) as SeriesDetailResponse;

describe("series facts times", () => {
  const SUMMER = Date.UTC(2026, 8, 21, 20, 0, 0) / 1000; // 16:00 New York, EDT
  const WINTER = Date.UTC(2026, 0, 21, 21, 0, 0) / 1000; // 16:00 New York, EST

  function facts(expiry: number): string {
    return renderToStaticMarkup(createElement(SeriesFacts, { detail: {
      ...detail, series: { ...detail.series, expiry, mintCutoff: expiry - 1_800 } } }));
  }

  it("renders expiry and the writing cutoff in New York, naming EDT or EST by the date", () => {
    const summer = facts(SUMMER);
    expect(summer).toContain("Sep 21, 2026, 4:00 PM EDT");
    expect(summer).toContain("Sep 21, 2026, 3:30 PM EDT");

    const winter = facts(WINTER);
    expect(winter).toContain("Jan 21, 2026, 4:00 PM EST");
    expect(winter).toContain("Jan 21, 2026, 3:30 PM EST");
  });

  it("leaves the reader's-local-time row to the browser", () => {
    expect(facts(SUMMER)).toContain("Your local time</dt><dd class=\"font-semibold\">Loading…");
  });
});
