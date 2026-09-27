import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConversionFloorCopy } from "./ConversionFloor";

describe("ConversionFloor copy", () => {
  const render = (props: Parameters<typeof ConversionFloorCopy>[0]) =>
    renderToStaticMarkup(createElement(ConversionFloorCopy, props));

  it("shows the route-aware floor only for a routed market", () => {
    const html = render({ state: { kind: "routed", floorBps: 9_920 } });
    // No zero tail on the percent, and the rule in one plain line (the floor already includes the route fee).
    expect(html).toContain("at least 99.2% of the tokens&#x27; value at settlement");
    expect(html).not.toContain("99.20%");
    expect(render({ state: { kind: "routed", floorBps: 9_915 } })).toContain("99.15%");
    expect(render({ state: { kind: "routed", floorBps: 9_700 } })).toContain("at least 97% of");
    expect(html).toContain("or you get the tokens");
  });

  it("says winning calls are paid in Stock Tokens for an unrouted market", () => {
    const html = render({ state: { kind: "unrouted" } });
    expect(html).toContain("no USDG conversion route");
    expect(html).toContain("Winning calls are paid in Stock Tokens");
    expect(html).not.toContain("conversion floor is");
  });

  it("distinguishes an unset adapter from an unavailable read", () => {
    expect(render({ state: { kind: "unset" } })).toContain("USDG conversion is disabled");
    expect(render({ state: { kind: "unset" } })).toContain("Winning calls are paid in Stock Tokens");
    expect(render({ unavailable: true })).toContain("payout route is unavailable");
  });
});
