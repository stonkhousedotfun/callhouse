import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { SeriesDetailResponse } from "@/lib/v2/api-types";
import { NEON_NIGHT, neutralSeriesImageLines, seriesImageLines } from "./seriesImage";

const detail = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../../ops/fixtures/api/v2/series/103958645695364239832519143371390703150538693767596812376310949450919320284464.json",
  import.meta.url)), "utf8")) as SeriesDetailResponse;

describe("series share image", () => {
  it("names the series, its New York expiry and the buyer's risk", () => {
    // The fixture: NVDA 224 call expiring 1789588800 = 2026-09-16 20:00 UTC = 16:00 New York.
    expect(seriesImageLines(detail.series)).toEqual({
      eyebrow: "NVDA · Call option",
      headline: "NVDA $224 call",
      detail: "Expires Sep 16, 2026 · settles on an averaged price",
      risk: "Max loss is the amount paid",
    });
    expect(seriesImageLines({ ...detail.series, isPut: true }).headline).toBe("NVDA $224 put");
  });

  it("carries no price, cost or multiple, live or illustrative", () => {
    for (const lines of [seriesImageLines(detail.series), neutralSeriesImageLines()]) {
      const text = Object.values(lines).join(" ");
      expect(text).not.toMatch(/USDG|×|\d+\.\d{2}/);
    }
    expect(Object.values(neutralSeriesImageLines()).join(" ")).not.toContain("$");
    // Not "Daily": SPCX lists Friday closes only.
    expect(Object.values(neutralSeriesImageLines()).join(" ")).not.toMatch(/daily/i);
  });

  it("uses the spec's night tokens", () => {
    expect(NEON_NIGHT).toMatchObject({ ground: "#000000", ink: "#FFFFFF", accent: "#C8FF2E", dangerText: "#FF8A7E" });
  });

  it("the route draws this card, not the Daylight brand image", () => {
    const route = readFileSync(resolve(import.meta.dirname, "opengraph-image.tsx"), "utf8");
    expect(route).toContain("renderSeriesImage(seriesImageLines(series))");
    expect(route).not.toContain("renderBrandImage");
  });
});
