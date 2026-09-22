import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FlywheelResponse } from "@/lib/v2/api-types";
import { TokenBurnsPanelView } from "./TokenBurnsPanel";

const firstBurn: FlywheelResponse = {
  configured: true,
  splitter: "0x0000000000000000000000000000000000000001",
  tokenAddress: "0x0000000000000000000000000000000000000002",
  tokenDecimals: 18,
  burnedTotal: "1250000000000000000000",
  burned7d: "250000000000000000000",
  revenue7d: [{
    asset: "0x0000000000000000000000000000000000000003",
    symbol: "NVDA",
    decimals: 18,
    amountRaw: "80000000000000000",
  }],
  held: [],
  lastDistribution: null,
  distributions: [],
};

describe("token burns panel", () => {
  it("stays hidden until the splitter is configured and a burn is recorded", () => {
    expect(renderToStaticMarkup(createElement(TokenBurnsPanelView, {
      data: { ...firstBurn, configured: false },
    }))).toBe("");
    expect(renderToStaticMarkup(createElement(TokenBurnsPanelView, {
      data: { ...firstBurn, burnedTotal: "0", burned7d: "0" },
    }))).toBe("");
  });

  it("shows the first recorded burn without inventing a fixed split", () => {
    const html = renderToStaticMarkup(createElement(TokenBurnsPanelView, { data: firstBurn }));
    expect(html).toContain("Token burns");
    expect(html).toContain("Only STONKHOUSE is burned");
    expect(html).toContain("Stock Token fees are sold for USDG first");
    expect(html).toContain("change waits 48 hours");
    expect(html).toContain("1250");
    expect(html).not.toMatch(/\b50\s*%|50\/50/i);
    expect(html).not.toMatch(/buyback/i);
  });
});
