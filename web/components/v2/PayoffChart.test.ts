import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { costToBuy } from "@/lib/v2/payoff";
import { ariaValueText, buildPayoffChart, defaultHandlePrice, type ChartInput } from "@/lib/v2/payoffChart";

import { PayoffChart } from "./PayoffChart";

/**
 * The payoff chart's drawing and its slider control, rendered statically (node environment). Event handlers cannot fire
 * here: the keyboard arithmetic is pinned in lib/v2/payoffChart.test.ts and the handler's wiring at source level.
 */
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const NOW = 1_790_000_000;
const units = 500n;
const take = costToBuy([{ orderId: "1", price: 1_000_000n, units }], units, fees);
const input: ChartInput = {
  ticker: "NVDA", isPut: false, strike: 234_000_000n, units, spot: 229_030_000n,
  cost: take.cost, premium: take.premium, exerciseFeeBps: 25, expiry: NOW + 86_400, now: NOW,
};
const source = readFileSync(resolve(import.meta.dirname, "PayoffChart.tsx"), "utf8");

function render(extra: Partial<Parameters<typeof PayoffChart>[0]> = {}): string {
  return renderToStaticMarkup(createElement(PayoffChart, { input, ...extra }));
}

function attr(html: string, name: string): string | null {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1]!.replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&") : null;
}

describe("payoff chart drawing", () => {
  it("draws the gradient-filled 3.5 px curve, the dashed hinge, the dashed cost line with its label, and a legend", () => {
    const html = render();
    expect(html).toContain('stop-color="var(--accent)" stop-opacity="0.34"');
    expect(html).toContain('stop-color="var(--accent)" stop-opacity="0"');
    expect(html).toMatch(/stroke="var\(--accent\)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/);
    expect(html).toMatch(/stroke="var\(--ink-3\)" stroke-width="1.5" stroke-dasharray="3 5"/);
    expect(html).toMatch(/stroke="var\(--danger-text\)" stroke-width="1.5" stroke-dasharray="6 5"/);
    expect(html).toContain("You paid 5.10 · above this line is profit");
    expect(html).toContain("Value before expiry (est.)");
    expect(html).toContain(">At expiry</span>");
    expect(html).toContain("Now $229.03");
    // The y axis starts at 0 and is value, not P&L: no negative labels.
    expect(html).toMatch(/>0<\/span>/);
    expect(html).not.toMatch(/>[−-]\d/);
  });

  it("drops the curve, keeps the hinge and says why when the ask cannot be fitted", () => {
    const html = render({ input: { ...input, premium: null } });
    expect(html).not.toContain('stroke-width="3.5"');
    expect(html).toMatch(/stroke-dasharray="3 5"/);
    expect(html).toContain("No live ask, so no before-expiry curve: the dashed line is the value at expiry.");
    expect(html).toContain("No live quote: at-expiry value only");
  });

  it("hides the Now label when spot is left of the $0 point", () => {
    const html = render({ input: { ...input, strike: 240_000_000n } });
    expect(buildPayoffChart({ ...input, strike: 240_000_000n }).domain.min).toBe(234_000_000n);
    expect(html).not.toContain("Now $");
  });

  it("shows the inverse tooltip with the exact expiry P&L as its headline", () => {
    const html = render({ price: 241_000_000n });
    const tip = html.slice(html.indexOf('data-testid="payoff-tooltip"'));
    expect(tip).toContain("bg-inverse-bg");
    expect(tip).toContain("NVDA at $241.00");
    expect(tip).toMatch(/[+−]\d+\.\d\d USDG/);
    expect(tip).toContain("at expiry · worth");
    expect(tip).toMatch(/≈ [+−]?\d+\.\d\d if sold a day early/);
    expect(html).toContain("the average of the last 30 minutes before the close");
    expect(html).toContain("Includes the exercise fee taken from the payout.");
  });
});

describe("payoff chart control", () => {
  it("is one role=slider over the plot, with value range = the domain and the price-at-expiry valuetext", () => {
    const html = render();
    expect(html.match(/role="slider"/g)).toHaveLength(1);
    const model = buildPayoffChart(input);
    expect(attr(html, "aria-valuemin")).toBe(String(Number(model.domain.min) / 1e6));
    expect(attr(html, "aria-valuemax")).toBe(String(Number(model.domain.max) / 1e6));
    const handle = defaultHandlePrice(input, model.domain);
    expect(attr(html, "aria-valuenow")).toBe(String(Number(handle) / 1e6));
    expect(attr(html, "aria-valuetext")).toBe(ariaValueText(model, handle));
    expect(attr(html, "aria-label")).toBe("NVDA price at expiry");
    expect(html).toContain('tabindex="0"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("defaults the handle to spot + 5 % and follows a controlled price", () => {
    expect(attr(render(), "aria-valuenow")).toBe("240.48");
    expect(attr(render({ price: 236_000_000n }), "aria-valuenow")).toBe("236");
    // A controlled price outside the domain clamps to its edge.
    expect(attr(render({ price: 1_000_000n }), "aria-valuenow")).toBe("228");
  });

  it("mirrors the value in a native range input over the same domain", () => {
    const html = render({ price: 236_000_000n });
    const range = html.slice(html.indexOf('<input type="range"'));
    expect(range).toContain('aria-label="NVDA price"');
    expect(range).toContain('min="228"');
    expect(range).toContain(`max="${Number(buildPayoffChart(input).domain.max) / 1e6}"`);
    expect(range).toContain('value="236"');
  });

  it("wires keyboard steps through keyboardChartPrice and keeps vertical touch scrolling", () => {
    const handler = source.slice(source.indexOf("function onKeyDown"), source.indexOf("const W = CHART_VIEW.width"));
    expect(handler).toContain("keyboardChartPrice(event.key, selected, model.domain)");
    expect(handler).toContain("event.preventDefault()");
    expect(source).toContain("touch-pan-y");
    expect(source).toContain('gesture.axis = "vertical"');
    expect(source).toContain("setPointerCapture");
  });

  it("renders the mini variant static: no slider, no range, no tooltip", () => {
    const html = render({ variant: "mini" });
    expect(html).not.toContain('role="slider"');
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain("payoff-tooltip");
    expect(html).toContain("h-[96px]");
    // Static, but still never silently without the exercise fee.
    expect(html).not.toContain("Before exercise fee");
    expect(render({ variant: "mini", input: { ...input, exerciseFeeBps: null } })).toContain("Before exercise fee");
  });
});
