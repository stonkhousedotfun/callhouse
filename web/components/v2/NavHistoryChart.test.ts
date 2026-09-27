import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NavHistoryChart, NO_CHART_YET, perShare, perShareUsdg, sharePriceText, type NavPoint } from "./NavHistoryChart";

const pt = (epoch: string, nav: bigint, supply: bigint | null, feeTaken = false): NavPoint => ({ epoch, at: 1_789_156_800, navUsdg: nav, supply, feeTaken });

/** Design test rule: the chart renders "No chart yet" when supply is absent -- today's wire. */
describe("NavHistoryChart", () => {
  it("says No chart yet when any point lacks supply, and draws nothing", () => {
    const html = renderToStaticMarkup(createElement(NavHistoryChart, { points: [pt("1", 1_000_000n, 10n ** 18n), pt("2", 1_010_000n, null)], tableId: "t" }));
    expect(html).toContain(NO_CHART_YET);
    expect(html).not.toContain("<svg");
    expect(renderToStaticMarkup(createElement(NavHistoryChart, { points: [], tableId: "t" }))).toContain(NO_CHART_YET);
  });

  it("draws one point per boundary with dashed connectors, the fee marker, and the accessible description", () => {
    const html = renderToStaticMarkup(createElement(NavHistoryChart, { points: [pt("1", 1_000_000n, 10n ** 18n), pt("2", 1_034_200n, 10n ** 18n, true)], tableId: "epochs" }));
    expect(html.match(/<circle/g)).toHaveLength(2);
    expect(html).toContain('stroke-dasharray="4 4"');
    expect(html).toContain("▲");
    expect(html).toContain('aria-describedby="epochs"');
    expect(html).toContain("Share price after close #2: 1.0342 USDG");
    expect(html).toContain("One dot per close. The lines between dots are not prices.");
    // What a reader sees or hears: the SVG's label and the caption. No internal words.
    const visible = [...html.matchAll(/aria-label="([^"]*)"|<figcaption[^>]*>([^<]*)</g)].map((m) => m[1] ?? m[2]).join(" ");
    expect(visible).toContain("close #2");
    expect(visible).not.toMatch(/epoch|boundar/i);
  });

  it("shows the share price through the shared money rules: no zero tail, no float digits", () => {
    expect(sharePriceText(pt("1", 1_000_000n, 10n ** 18n))).toBe("1");
    expect(sharePriceText(pt("1", 1_050_000n, 10n ** 18n))).toBe("1.05");
    expect(sharePriceText(pt("1", 1_034_200n, 10n ** 18n))).toBe("1.0342");
    // Truncated toward zero, never rounded up past what the vault holds.
    expect(sharePriceText(pt("1", 1_034_299n, 10n ** 18n))).toBe("1.0342");
    expect(sharePriceText(pt("1", 1n, 10n ** 18n))).toBe("<0.0001");
    expect(sharePriceText(pt("1", 1n, null))).toBe("—");
    const html = renderToStaticMarkup(createElement(NavHistoryChart, { points: [pt("7", 1_000_000n, 10n ** 18n)], tableId: "t" }));
    expect(html).toContain("Share price after close #7: 1 USDG");
    expect(html).not.toContain("1.0000");
  });

  it("perShare is navUsdg * 1e18 / supply in USDG, null on a zero or absent supply", () => {
    expect(perShare(pt("1", 2_000_000n, 2n * 10n ** 18n))).toBe(1);
    expect(perShare(pt("1", 1n, 0n))).toBeNull();
    expect(perShare(pt("1", 1n, null))).toBeNull();
    expect(perShareUsdg(pt("1", 3_000_000n, 2n * 10n ** 18n))).toBe(1_500_000n);
  });
});
