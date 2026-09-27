/** StatTile: a Stat in a card, with an optional "View rows" action slot. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";
import { StatTile } from "./Stat";

describe("StatTile", () => {
  it("is a card around a stat, keeping both sets of test hooks", () => {
    const out = renderToStaticMarkup(createElement(StatTile, { label: "Fees paid", value: "0.00", unit: "USDG" }));
    expect(out).toContain('data-slot="card"');
    expect(out).toContain('data-tile="stat"');
    expect(out).toContain('data-slot="stat-label"');
    expect(out).toContain(">Fees paid<");
    expect(out).toContain("0.00");
  });

  it("renders the action slot only when given one", () => {
    const withAction = renderToStaticMarkup(createElement(StatTile, {
      label: "Realised P&L", value: "0.00",
      action: createElement(Button as never, { size: "sm", variant: "ghost", href: "#history" }, "View rows"),
    }));
    expect(withAction).toContain('data-slot="stat-tile-action"');
    expect(withAction).toContain('href="#history"');
    expect(withAction).toContain("View rows");
    const without = renderToStaticMarkup(createElement(StatTile, { label: "Fills", value: "0" }));
    expect(without).not.toContain("stat-tile-action");
  });
});
