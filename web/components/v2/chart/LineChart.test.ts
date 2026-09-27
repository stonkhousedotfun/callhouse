/**
 * LineChart, rendered on the server as the rest of the web tests do: gridlines, round price levels, time
 * ticks, the line with its area fill, and the crosshair's floating date + hour and price labels.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CHART_VIEW, LineChart, plotOf } from "./LineChart";
import type { ChartPoint } from "./chartMath";

// 2026-09-24 12:00 UTC onwards, 15-minute points.
const T0 = 1_790_251_200;
const pts: ChartPoint[] = Array.from({ length: 40 }, (_, i) => ({ t: T0 + i * 900, v: 228 + i * 0.1 }));

const render = (props: Partial<Parameters<typeof LineChart>[0]> = {}) =>
  renderToStaticMarkup(createElement(LineChart, { points: pts, label: "NVDA price", timeZone: "UTC", ...props }));

describe("plotOf", () => {
  it("spans the box left to right with the lowest price lowest", () => {
    const p = plotOf(pts)!;
    expect(p.xy[0].x).toBe(0);
    expect(p.xy.at(-1)!.x).toBe(CHART_VIEW.width);
    expect(p.xy[0].y).toBeGreaterThan(p.xy.at(-1)!.y);
    expect(p.yTicks.length).toBeGreaterThanOrEqual(4);
    expect(p.hours).toBe(true);
  });

  it("needs two distinct times", () => {
    expect(plotOf([])).toBeNull();
    expect(plotOf([pts[0]])).toBeNull();
    expect(plotOf([pts[0], { ...pts[0], v: 1 }])).toBeNull();
  });
});

describe("LineChart", () => {
  it("draws gridlines, price levels, time ticks, the line and its fill, and is focusable", () => {
    const html = render();
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="NVDA price"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("<polyline");
    expect(html).toContain("url(#");
    expect(html.match(/data-slot="y-tick"/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).toMatch(/data-slot="x-tick"[^>]*>\d\d:00</);
    expect(html).toContain("$228");
    // No crosshair until the pointer or a key puts one there; the readout names the latest point.
    expect(html).not.toContain('data-slot="crosshair"');
    expect(html).toContain("Latest $231.9 at Sep 24, 9:45 PM UTC"); // The zone is named
  });

  it("with the crosshair on a point: a guide line, the DATE + HOUR on X and the PRICE on Y", () => {
    const html = render({ initialActive: 8 });
    expect(html).toContain('data-slot="crosshair"');
    expect(html).toMatch(/data-slot="crosshair-time"[^>]*>Sep 24, 2:00 PM UTC</);
    expect(html).toMatch(/data-slot="crosshair-price"[^>]*>\$228\.8</);
    expect(html).toContain("Sep 24, 2:00 PM UTC: $228.8");
  });

  it("renders nothing when there is nothing to draw -- the caller shows its own empty state", () => {
    expect(render({ points: [pts[0]] })).toBe("");
  });
});
