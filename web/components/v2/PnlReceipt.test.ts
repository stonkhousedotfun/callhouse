import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { txUrl } from "@/lib/chain";
import type { PnlResponse } from "@/lib/v2/api-types";
import { payoutAt } from "@/lib/v2/payoff";
import { buildPayoffChart } from "@/lib/v2/payoffChart";
import { receiptChartSvg } from "./PnlImage";
import { MULTIPLE_LABEL, PnlReceipt, RECEIPT_DISCLAIMER, receiptDate, receiptView } from "./PnlReceipt";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/pnl/87928758254318692721909164101369622513960639781458875980445111726519827316414-0x4088c59Eb3fB713B124f182E7083AEb3358A030B.json"), "utf8")) as PnlResponse;

describe("PnL receipt", () => {
  it("describes a resale-only realised win without claiming its closing tx is a redemption", () => {
    // The wire response has no closure kind. A profitable secondary resale has the
    // same shape as a redeemed position, so every receipt must use truthful copy.
    const resaleOnly = { ...fixture, payout: { ...fixture.payout, raw: "10287200", formatted: "10.2872" }, multiple: 10 };
    const html = renderToStaticMarkup(createElement(PnlReceipt, { pnl: resaleOnly }));
    expect(html).toContain("Closing transaction");
    expect(html).toContain("sale proceeds");
    expect(html).toContain("USDG value");
    expect(html).toContain("Stock Tokens paid in kind are valued at the settlement price");
    expect(html).not.toContain("Settlement transaction");
    expect(html).not.toContain("verify the redemption");
  });
});

/** The win receipt. The fixture: 50 units of the NVDA $210 call expiring
 * 1789156800, 1.02872 USDG paid, 4.421323 USDG value, entry spot 206.10, settled at 219.40, multiple 4.29. */
describe("win receipt card", () => {
  const html = (pnl: PnlResponse | null) => renderToStaticMarkup(createElement(PnlReceipt, { pnl }));

  it("builds every line of the card from the outcome, not from the mockup", () => {
    const view = receiptView(fixture);
    expect(view.receiptNo).toBe("RECEIPT #7aa2");
    expect(view.option).toBe(`NVDA $210 call · ${receiptDate(1789156800)}`);
    expect(receiptDate(1789156800)).toBe("Fri 11 Sep");
    expect(view.multiple).toBe("4.29×");
    // Costs round up to the cent, value down (the explorer's rule): 1.02872 -> 1.03, 4.421323 -> 4.42.
    expect(view.paidGot).toBe("Paid 1.03 USDG → got 4.42 USDG value");
    expect(view.entry).toBe("NVDA $206.10");
    expect(view.exit).toBe("Settled $219.40");
    expect(view.wallet).toBe("0x4088…030B");
  });

  it("labels the multiple as the realised got ÷ paid, a fact rather than a scenario", () => {
    const page = html(fixture);
    expect(MULTIPLE_LABEL).toBe("Realised: value got ÷ paid");
    expect(page).toContain(MULTIPLE_LABEL);
    expect(page).toContain("sm:text-[140px]");
    expect(page).not.toMatch(/If [+−-]\d+ ?%/);
  });

  it("marks the exit on a static mini payoff chart: the settlement price when settled", () => {
    const view = receiptView(fixture);
    expect(view.chart).not.toBeNull();
    const chart = view.chart!;
    expect(chart.price).toBe(219_400_000n);
    expect(chart.input).toMatchObject({ ticker: "NVDA", isPut: false, strike: 210_000_000n, units: 50n, cost: 1_028_720n, premium: null });
    // The dot sits on the exact expiry value at the exit (no live quote, so no before-expiry curve).
    const model = buildPayoffChart(chart.input);
    expect(model.estimate.ok).toBe(false);
    expect(model.at(chart.price).expiryValue).toBe(payoutAt(219_400_000n, { isPut: false, strike: 210_000_000n, units: 50n, exerciseFeeBps: 0 }));
    const page = html(fixture);
    expect(page).toContain("<svg");
    // The caption names the dot; the line legend moved into the caption's "?" (still in the page).
    expect(view.chart!.caption).toBe("Dot: settled at $219.40.");
    expect(view.chart!.legend).toBe("Dotted: entry price $206.10. Dashed: value at expiry. Red: what was paid.");
    const noSpot = receiptView({ ...fixture, spotAtEntry: null }).chart!;
    expect(noSpot.caption).toBe("Dot: settled at $219.40.");
    expect(noSpot.legend).toBe("Dashed: value at expiry. Red: what was paid.");
    expect(page).toContain("Dot: settled at $219.40.");
    expect(page).toContain(view.chart!.legend);
    expect(page).toContain('aria-label="About the chart"');
    // The OG image draws the same model.
    const svg = receiptChartSvg(view)!;
    expect(svg.dot).toEqual({ x: model.at(chart.price).x, y: model.at(chart.price).y });
    expect(svg.expiry).toBe(model.expiryPath);
  });

  it("says a position sold before expiry has no exit price, and marks the entry spot instead", () => {
    const sold = { ...fixture, settlementPrice: null };
    const view = receiptView(sold);
    expect(view.exit).toBe("Sold early");
    expect(view.chart!.price).toBe(206_100_000n);
    expect(view.chart!.caption).toBe("Sold before expiry. Dot: entry price $206.10.");
    expect(view.chart!.legend).toBe("Dashed: value at expiry. Red: what was paid.");
    const neither = receiptView({ ...fixture, settlementPrice: null, spotAtEntry: null });
    expect(neither.entry).toBe("—");
    expect(neither.chart!.price).toBe(210_000_000n);
    expect(neither.chart!.caption).toBe("Sold before expiry.");
    expect(neither.chart!.legend).toBe("Dashed: value at expiry. Red: what was paid.");
  });

  it("drops the chart rather than draw a wrong one when a figure is not USDG-6", () => {
    const odd = { ...fixture, cost: { ...fixture.cost, decimals: 18 } };
    expect(receiptView(odd).chart).toBeNull();
    expect(receiptChartSvg(receiptView(odd))).toBeNull();
    expect(html(odd)).not.toContain("Dot:");
  });

  it("shares on X, links the closing transaction on the explorer, and carries the disclaimer", () => {
    const page = html(fixture);
    expect(page).toContain("https://x.com/intent/post?");
    expect(page).toContain(">Share on X<");
    expect(page).toContain(`href="${txUrl(fixture.tx)}"`);
    expect(page).toContain(">View on explorer<");
    expect(page).toContain(RECEIPT_DISCLAIMER);
    // One line, no "past wins" padding.
    expect(RECEIPT_DISCLAIMER).toBe("Most options expire worthless.");
  });

  it("ships none of the mockup's illustrative figures", () => {
    const page = html(fixture);
    for (const mock of ["#4f2a", "0x9e2D", "71aa", "$245 call", "8.0×", "0.52 USDG", "4.16 USDG", "$229.03", "Fri 25 Sep"]) {
      expect(page).not.toContain(mock);
    }
  });

  it("keeps a designed unavailable state", () => {
    const page = html(null);
    expect(page).toContain("This outcome is unavailable");
    expect(page).toContain("Explore options");
    expect(page).toContain("stonkhouse");
  });

  it("draws the OG image in the new fonts and the night palette (night by default)", () => {
    const source = readFileSync(resolve(import.meta.dirname, "PnlImage.tsx"), "utf8");
    expect(source).not.toMatch(/Schibsted|Figtree/);
    expect(source).toContain('const SANS = "Plus Jakarta Sans";');
    expect(source).toContain('const MONO = "JetBrains Mono";');
    expect(source).toContain('accent: "#C8FF2E"');
    expect(source).toContain('ground: "#000000"');
  });
});
