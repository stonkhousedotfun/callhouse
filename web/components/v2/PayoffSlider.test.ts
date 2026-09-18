import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PayoffSlider } from "./PayoffSlider";

describe("payoff slider payout copy", () => {
  const common = { ticker: "NVDA", spot: 220_000_000n, cost: 1_000_000n };

  it("labels a call's fee-net number as settlement value before conversion", () => {
    const html = renderToStaticMarkup(createElement(PayoffSlider, {
      ...common,
      position: { isPut: false, strike: 200_000_000n, units: 100n, exerciseFeeBps: 25 },
    }));
    expect(html).toContain("estimated settlement value");
    expect(html).toContain("USDG conversion may deliver less or fall back to tokens");
    expect(html).toContain("Estimated break-even");
    expect(html).not.toContain("you get ");
  });

  it("keeps a put's direct USDG payout wording", () => {
    const html = renderToStaticMarkup(createElement(PayoffSlider, {
      ...common,
      position: { isPut: true, strike: 230_000_000n, units: 100n, exerciseFeeBps: 25 },
    }));
    expect(html).toContain("you get");
    expect(html).toContain("USDG");
    expect(html).not.toContain("conversion may deliver less");
    expect(html).not.toContain("Estimated break-even");
  });
});
