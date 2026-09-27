import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { breakeven, costToBuy } from "@/lib/v2/payoff";
import { ariaValueText, buildPayoffChart, chartDomain } from "@/lib/v2/payoffChart";
import { scenarioFigures } from "@/lib/v2/payoffReceipt";

import { CEILING_TERMS, PayoffSlider, scenarioSentence } from "./PayoffSlider";

/**
 * The ticket's payoff explorer, rebuilt on the neon PayoffChart. The ticket is the design
 * example: 300 units at 4.1333 USDG/share, strike 230, exercise fee 25 bps, spot 220.
 *
 * Changed ON PURPOSE from the version of this file, each for a stated reason:
 * - The slider's label is "price at expiry" and its value text is the chart's value sentence, because the control is
 *   now PayoffChart's (one component for the market page, phone and receipts).
 * - Its range is the chart's domain (from where the option is worth $0) rather than spot ± 25 %, and the untouched
 *   handle sits at spot + 5 % (a put: − 5 %) instead of at spot.
 * - The nine preset chips are gone: the revised domain starts at the $0 point, so −20 % / −10 % chips on a
 *   call would sit outside the plot and could only clamp to its edge under a wrong label. The range input and the
 *   0.50 / 5.00 keyboard steps replace them.
 * - The red/green area fills, the zero line and the spot/strike/break-even markers are gone: the chart is option
 *   value from 0, not P&L, so there is no loss region to fill.
 * What did NOT change and is still pinned below: the four tiles and their order, both call break-evens (G4), the
 * put's single USDG figure, the band copy and the wire's conversion terms.
 * The drag hint and the call's band note moved into the
 * heading's "?" tip, the max-loss sub-line went, the size reads in shares, and break-evens show cents.
 */
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const quote = costToBuy([{ orderId: "1", price: 4_133_300n, units: 300n }], 300n, fees);
const call = { isPut: false, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
const put = { isPut: true, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
const spot = 220_000_000n;
const NOW = 1_790_000_000;

function render(position: typeof call, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(PayoffSlider, { ticker: "NVDA", spot, position, cost: quote.cost, ...extra }));
}

function attr(html: string, name: string): string | null {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1]!.replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&") : null;
}

describe("payoff slider on the neon chart", () => {
  it("exposes one slider over the chart's price domain, handle at spot + 5 %, with the formatted value text", () => {
    const html = render(call);
    expect(html.match(/role="slider"/g)).toHaveLength(1);
    // 230 × 0.975 = 224.25 → 224; max(220 × 1.12 = 246.4, 248.4) → 249.
    expect(chartDomain(false, call.strike, spot)).toEqual({ min: 224_000_000n, max: 249_000_000n, reversed: false });
    expect(attr(html, "aria-valuemin")).toBe("224");
    expect(attr(html, "aria-valuemax")).toBe("249");
    expect(attr(html, "aria-valuenow")).toBe("231");
    // Read from the slider itself: the heading's "?" button carries the page's first aria-label.
    expect(attr(html.slice(html.indexOf('role="slider"')), "aria-label")).toBe("NVDA price at expiry");
    const model = buildPayoffChart({ ticker: "NVDA", ...call, spot, cost: quote.cost, premium: null, expiry: null, now: null });
    expect(attr(html, "aria-valuetext")).toBe(ariaValueText(model, 231_000_000n));
    expect(html).toContain("Drag the chart or use the arrow keys.");
    // The presets are retired (see the header).
    expect(html).not.toContain('aria-label="Price presets"');
  });

  it("fits the curve to the live premium when the ticket passes it, and says why not when it does not", () => {
    const fitted = render(call, { premium: quote.premium, expiry: NOW + 86_400, now: NOW });
    expect(fitted).toMatch(/Black–Scholes at \d+ % implied vol from the live ask/);
    expect(fitted).toContain('stroke-width="3.5"');
    const bare = render(call);
    expect(bare).toContain("No live ask, so no before-expiry curve");
    expect(bare).not.toContain('stroke-width="3.5"');
  });
});

describe("payoff slider tiles and copy", () => {
  it("shows the four tiles in the spec's order and prices the call at the handle with a band", () => {
    const html = render(call);
    const tiles = ["Max loss", "Break-even", "Value at $231.00", "Net P&amp;L"].map((label) => html.indexOf(`>${label}</dt>`));
    expect(tiles.every((index) => index > -1)).toBe(true);
    expect([...tiles].sort((a, b) => a - b)).toEqual(tiles);
    expect(html).toContain("12.50 USDG");
    expect(html).not.toContain("never changes with the slider");
    // Call: two break-evens, labelled (G4). Independent of the handle.
    expect(breakeven(call, quote.cost)).toBe(234_629_667n);
    expect(html).toContain("in tokens $234.62");
    expect(html).toContain("in USDG about $234.77");
    const figures = scenarioFigures(call, quote.cost, 231_000_000n, CEILING_TERMS);
    expect(html).toContain(scenarioSentence("NVDA", false, figures, quote.cost));
    // $1 in the money on 3 shares, far below the 12.50 paid: a loss, marked by glyph as well as colour.
    expect(figures.pnlHigh.pnl).toBeLessThan(0n);
    expect(html).toContain("▼ ");
    expect(html).toContain("Winning calls are owed Stock Tokens; USDG conversion may deliver less or fall back to tokens.");
    expect(html).toContain("3 shares · option value by price");
    // lib/v2/tradeTicket.test.ts pins this heading on the mounted ticket; the tip sits inside it.
    expect(html).toMatch(/>Explore the payoff <span[^>]*><button[^>]*aria-label="About the payoff"/);
  });

  it("gives a put one break-even and one USDG figure, with no band or token copy, handle at spot − 5 %", () => {
    const html = render(put);
    // 220 × 0.95 = 209.00. Paid 21.00 × 3 shares = 63.00 gross; the fee is 0.25 % of the 2.30 collateral per unit
    // (0.00575, under the 10 % payout cap), so 300 × 0.20425 = 61.275, shown floored.
    expect(html).toContain("If NVDA settles at $209.00 you receive 61.27 USDG — you paid 12.50 USDG.");
    expect(html).toContain("USDG you receive");
    expect(html).toContain("▲ +48.77 USDG");
    expect(html).toContain(">Break-even</dt>");
    expect(html).toContain("$225.37");
    expect(html).not.toContain("in tokens");
    expect(html).not.toContain("Stock Tokens worth about");
    expect(html).not.toContain("conversion may deliver less");
  });

  it("marks a ticket no price can pay for instead of printing a wrong break-even", () => {
    const hopeless = render(put, { cost: 3_000_000_000n });
    expect(hopeless).toContain("this option cannot cover its cost at any price");
  });

  it("lets the wire's slippage bound narrow the band and keeps the ceiling as the default", () => {
    expect(CEILING_TERMS).toEqual({ slippageBps: 300, routeFeeBps: 100 });
    const tight = scenarioFigures(call, quote.cost, 240_000_000n, { slippageBps: 50, routeFeeBps: 30 });
    const ceiling = scenarioFigures(call, quote.cost, 240_000_000n, CEILING_TERMS);
    expect(tight.band!.low).toBeGreaterThan(ceiling.band!.low);
    expect(tight.band!.high).toBe(ceiling.band!.high);
    expect(scenarioSentence("NVDA", false, tight, quote.cost)).toContain("worth about between 27.97 and 28.19 USDG");
    expect(scenarioSentence("NVDA", false, ceiling, quote.cost)).toContain("worth about between 27.35 and 28.19 USDG");
  });

  it("hands the chosen scenario to whatever is mounted under it", () => {
    const html = render(call, { renderScenario: (s: { price: bigint; moved: boolean }) => createElement("p", null, `scenario ${s.price} ${s.moved}`) });
    expect(html).toContain("scenario 231000000 false");
  });
});
