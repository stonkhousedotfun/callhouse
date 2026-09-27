import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EarnFacts, earnFacts } from "./EarnFacts";

describe("the Earn facts card", () => {
  it("answers the four questions in order: what, when paid, taking it back, the risk", () => {
    expect(earnFacts("NVDA", false).map((fact) => fact.label))
      .toEqual(["What you earn", "When you get paid", "Taking it back", "The risk"]);
  });

  it("calls: says there is no fixed APY, explains the strike, and names the capped upside", () => {
    const text = earnFacts("NVDA", false).map((fact) => fact.value).join(" ");
    expect(text).toContain("There is no fixed APY");
    expect(text).toContain("Free NVDA Stock Tokens can be withdrawn any time");
    expect(text).toContain("strike (the price you agreed to sell at)");
    expect(text).toContain("the gain above it goes to the buyer");
    expect(text).not.toMatch(/\bputs?\b/i);
  });

  it("puts: USDG collateral and the downside, only when the page is on a put market", () => {
    const text = earnFacts("NVDA", true).map((fact) => fact.value).join(" ");
    expect(text).toContain("Free USDG can be withdrawn any time");
    expect(text).toContain("strike (the price you agreed to buy at)");
    expect(text).toContain("you pay the difference from your USDG");
  });

  it("renders as a labelled definition list", () => {
    const html = renderToStaticMarkup(createElement(EarnFacts, { ticker: "SPCX", isPut: false }));
    expect(html).toContain('aria-label="How Earn works"');
    expect(html.match(/<dt/g)).toHaveLength(4);
    expect(html).toContain("SPCX Stock Tokens");
  });
});
