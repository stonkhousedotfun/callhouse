import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, breakeven, breakevenUsdg, costToBuy } from "@/lib/v2/payoff";
import { keyboardPriceStep, payoffPriceRange, presetPrices } from "@/lib/v2/payoffCurve";
import { scenarioFigures } from "@/lib/v2/payoffReceipt";

import { CEILING_TERMS, PayoffSlider, scenarioSentence } from "./PayoffSlider";

/**
 * T-OP-120. The explorer's hero (design §2.2-2.4, §2.7): the slider's roles and values, the nine presets, the four
 * tiles in order, the band copy for a call and the single USDG figure for a put. Rendered statically (node
 * environment); the keyboard handler is pinned at source level and its arithmetic through keyboardPriceStep.
 * The ticket is the design example: 300 units at 4.1333 USDG/share, strike 230, exercise fee 25 bps, spot 220.
 */
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const quote = costToBuy([{ orderId: "1", price: 4_133_300n, units: 300n }], 300n, fees);
const call = { isPut: false, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
const put = { isPut: true, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
const spot = 220_000_000n;
const source = readFileSync(resolve(import.meta.dirname, "PayoffSlider.tsx"), "utf8");

function render(position: typeof call, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(createElement(PayoffSlider, { ticker: "NVDA", spot, position, cost: quote.cost, ...extra }));
}

function attr(html: string, name: string): string | null {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1]!.replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&") : null;
}

describe("payoff slider a11y", () => {
  it("exposes one slider whose value range is the curve's price range and whose text is the scenario sentence", () => {
    const html = render(call);
    expect(html.match(/role="slider"/g)).toHaveLength(1);
    const range = payoffPriceRange(spot, call.strike);
    expect(attr(html, "aria-valuemin")).toBe(String(Number(range.min) / 1e6));
    expect(attr(html, "aria-valuemax")).toBe(String(Number(range.max) / 1e6));
    // Untouched, the handle follows spot.
    expect(attr(html, "aria-valuenow")).toBe("220");
    expect(attr(html, "aria-label")).toBe("NVDA price at settlement");
    const figures = scenarioFigures(call, quote.cost, spot, CEILING_TERMS);
    expect(attr(html, "aria-valuetext")).toBe(`${scenarioSentence("NVDA", false, figures, quote.cost)} Max loss: 12.50 USDG.`);
    expect(html).toContain('tabindex="0"');
    // The chart itself is decoration; the slider div is the control.
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    // A polite live region exists for preset announcements and is empty until one is chosen (§2.7).
    expect(html).toMatch(/role="status" aria-live="polite" class="sr-only"><\/p>/);
    expect(html).toContain("Drag the chart, tap a price or a preset, or use arrow keys. Page Up and Down move faster; Home and End go to the edges.");
  });

  it("handles every keyboard step the spec names, by one step, ten steps, or to an edge", () => {
    // Static markup cannot receive key events; the handler's cases are pinned here and its arithmetic below.
    const handler = source.slice(source.indexOf("function onKeyDown"), source.indexOf("const plotBottom"));
    for (const key of ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "PageUp", "PageDown", "Home", "End"]) {
      expect(handler, key).toContain(`case "${key}"`);
    }
    expect(handler).toContain("selected + step");
    expect(handler).toContain("selected - step");
    expect(handler).toContain("step * 10n");
    expect(handler).toContain("curve.range.min");
    expect(handler).toContain("curve.range.max");
    expect(handler).toContain("event.preventDefault()");
    const range = payoffPriceRange(spot, call.strike);
    const step = keyboardPriceStep(range);
    // One percent of the visible range, at least one cent, on a cent boundary.
    expect(step).toBeGreaterThanOrEqual(10_000n);
    expect(step % 10_000n).toBe(0n);
    expect(step).toBe((((range.max - range.min + 99n) / 100n + 9_999n) / 10_000n) * 10_000n);
  });

  it("offers the nine presets as buttons in a labelled group, marks the active one, and disables an unreachable break-even", () => {
    const html = render(call);
    const group = html.slice(html.indexOf('role="group" aria-label="Price presets"'), html.indexOf("<dl"));
    for (const label of ["−20 %", "−10 %", "−5 %", "Spot", "+5 %", "+10 %", "+20 %", "At strike", "Break-even"]) {
      expect(group, label).toContain(`>${label}</button>`);
    }
    expect(group.match(/<button/g)).toHaveLength(9);
    expect(group.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(group).toMatch(/aria-pressed="true"[^>]*>Spot<\/button>/);
    // Untouched: no reset pill.
    expect(group).not.toContain("Reset to spot");
    const be = breakevenUsdg(call, quote.cost, MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS);
    expect(presetPrices(spot, call.strike, be).map((preset) => preset.price)).toEqual([
      176_000_000n, 198_000_000n, 209_000_000n, 220_000_000n, 231_000_000n, 242_000_000n, 264_000_000n, 230_000_000n, be,
    ]);
    // A ticket no price can pay for: the break-even chip is disabled, never a wrong number.
    const hopeless = render(put, { cost: 3_000_000_000n });
    expect(hopeless).toMatch(/<button[^>]*disabled=""[^>]*>Break-even<\/button>/);
    expect(hopeless).toContain("this option cannot cover its cost at any price");
  });
});

describe("payoff slider tiles and copy", () => {
  it("shows the four tiles in the spec's order and prices the call at spot with a band", () => {
    const html = render(call);
    const tiles = ["Max loss", "Break-even", "Value at $220.00", "Net P&amp;L"].map((label) => html.indexOf(`>${label}</dt>`));
    expect(tiles.every((index) => index > -1)).toBe(true);
    expect([...tiles].sort((a, b) => a - b)).toEqual(tiles);
    expect(html).toContain("12.50 USDG");
    expect(html).toContain("always — never changes with the slider");
    // Call: two break-evens, labelled (G4).
    expect(breakeven(call, quote.cost)).toBe(234_629_667n);
    expect(html).toContain("in kind $234.629667");
    expect(html).toContain("in USDG about $234.772778");
    expect(html).toContain("Break-even in USDG");
    // Out of the money at spot: zero tokens, a zero band, the full loss.
    expect(html).toContain("0.000000 NVDA");
    expect(html).toContain("Stock Tokens worth about 0.00 USDG");
    expect(html).toContain("▼ −12.50 USDG");
    expect(html).toContain("−100 % · 0.00×");
    expect(html).toContain("If NVDA settles at $220.00 you receive 0.000000 NVDA, worth about 0.00 USDG — you paid 12.50 USDG.");
    expect(html).toContain("Winning calls are owed Stock Tokens. USDG conversion may deliver less or fall back to tokens; the band is the floor to the settlement value.");
    expect(html).toContain("At settlement · 300 × 0.01 share");
    expect(html).not.toContain("sell now");
  });

  it("gives a put one break-even and one USDG figure, with no band or token copy", () => {
    const html = render(put);
    expect(html).toContain("If NVDA settles at $220.00 you receive 28.27 USDG — you paid 12.50 USDG.");
    expect(html).toContain("USDG you receive");
    expect(html).toContain("▲ +15.77 USDG");
    expect(html).toContain("+126 % · 2.26×");
    expect(html).toContain(">Break-even</dt>");
    expect(html).toContain("$225.3704");
    expect(html).not.toContain("in kind");
    expect(html).not.toContain("Break-even in USDG");
    expect(html).not.toContain("Stock Tokens worth about");
    expect(html).not.toContain("conversion may deliver less");
    expect(html).not.toContain("worth about between");
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

  it("draws the zero line, both fills and the three markers, and honours reduced motion", () => {
    const html = render(call);
    expect(html).toContain('fill="var(--accent)" fill-opacity="0.14"');
    expect(html).toContain('fill="var(--danger)" fill-opacity="0.12"');
    expect(html).toContain('stroke="var(--line-2)" stroke-width="1.5"');
    expect(html).toContain('stroke="var(--warn)"');
    expect(html).toContain('stroke="var(--ink-3)"');
    expect(html).toContain('stroke="var(--usdg)"');
    expect(html).toContain("motion-reduce:transition-none");
    // The handle is a 44 px target (§2.7).
    expect(html).toContain("h-11 w-11");
    expect(html).toContain("h-[200px] w-full sm:h-[260px]");
    // Colour never carries the meaning alone: an arrow glyph accompanies red or green.
    expect(source).toContain('"▲ "');
    expect(source).toContain('"▼ "');
  });
});
