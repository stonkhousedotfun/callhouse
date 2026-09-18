import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Card } from "@/lib/v2/api-types";
import { PayoffCard } from "./PayoffCard";

const fixture = fileURLToPath(new URL("../../../ops/fixtures/api/v2/cards.json", import.meta.url));
const cards = JSON.parse(readFileSync(fixture, "utf8")) as { items: Card[]; generatedAt: number };

describe("payoff card with an unavailable market spot", () => {
  it("hides the pricing-feed spot and disables the buy link", () => {
    const card = cards.items[0]!;
    const html = renderToStaticMarkup(createElement(PayoffCard, {
      card, feeParams: { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 },
      now: cards.generatedAt, quoteAsOf: null, spotAvailable: false,
    }));
    expect(html).toContain("Unavailable");
    expect(html).not.toContain(`$${card.spot!.formatted}`);
    expect(html).toContain("Quote is stale");
    expect(html).toContain("Buy unavailable");
    expect(html).not.toContain("?buy=1");
  });

  it("renders an available ask when the card spot itself is null", () => {
    const card = { ...cards.items[0]!, spot: null };
    const html = renderToStaticMarkup(createElement(PayoffCard, {
      card, feeParams: { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 },
      now: cards.generatedAt, quoteAsOf: null, spotAvailable: false,
    }));
    expect(html).toContain("Unavailable");
    expect(html).toContain("Buy unavailable");
    expect(html).toContain(card.series.ticker);
  });

  it("labels its initial centi-share buy size in shares", () => {
    const html = renderToStaticMarkup(createElement(PayoffCard, {
      card: cards.items[1]!, feeParams: { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 },
      now: cards.generatedAt, quoteAsOf: cards.generatedAt,
    }));
    expect(html).toContain("Buy 0.01 shares");
  });
});
