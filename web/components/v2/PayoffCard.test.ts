import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Card } from "@/lib/v2/api-types";
import { PayoffCard, UNAVAILABLE_LABEL } from "./PayoffCard";
import type { CardState } from "@/lib/v2/payoffCard";

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
    // UX item 9: the button used to read "Buy unavailable" while the status line one row above it
    // already said WHY. It now carries the same reason, so a reader who looks only at the control
    // learns the same thing as a reader who looks above it.
    expect(html).toContain("Quote refreshing");
    expect(html).not.toContain("Buy unavailable");
    expect(html).not.toContain("?buy=1");
  });

  it("renders an available ask when the card spot itself is null", () => {
    const card = { ...cards.items[0]!, spot: null };
    const html = renderToStaticMarkup(createElement(PayoffCard, {
      card, feeParams: { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 },
      now: cards.generatedAt, quoteAsOf: null, spotAvailable: false,
    }));
    expect(html).toContain("Unavailable");
    expect(html).toContain("Quote refreshing");
    expect(html).not.toContain("Buy unavailable");
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

/**
 * UX review item 9: a disabled control has to say why.
 *
 * WHY THE LABELS ARE KEYED ON `CardState` RATHER THAN WRITTEN INLINE: the status line above the
 * button already switched on that union, so an inline string here could disagree with the line
 * directly above it — and the reader would have two answers. A `Record<CardState, string>` makes
 * a new state a compile error rather than a silent "Buy unavailable".
 */
describe("the buy button carries its own reason", () => {
  const base = { feeParams: { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 }, now: cards.generatedAt };

  it("EVERY card state has its own reason, and none of them is a bare 'unavailable'", () => {
    // WHY THIS IS A MAP TEST AND NOT A RENDER TEST, said rather than omitted: the disabled button
    // for the `thin` state only appears once the reader has SELECTED a size larger than the book
    // — at the default 0.01 the card is buyable and renders a Buy link. `renderToStaticMarkup`
    // cannot click, so a render test for `thin` would either be impossible or would quietly
    // assert something else. The map is what the component reads, so asserting it covers the
    // state the render cannot reach.
    const states: CardState[] = ["live", "thin", "stale", "cutoff"];
    for (const state of states) {
      expect(UNAVAILABLE_LABEL[state], state).toBeTruthy();
    }
    expect(UNAVAILABLE_LABEL.thin).toBe("Not enough depth");
    expect(UNAVAILABLE_LABEL.stale).toBe("Quote refreshing");
    expect(UNAVAILABLE_LABEL.cutoff).toBe("Trading closed");
    // `live` keeps the generic wording on purpose: if a card is live and still not buyable, the
    // reason is not one of the states above and inventing a specific sentence would be a guess.
    expect(UNAVAILABLE_LABEL.live).toBe("Buy unavailable");
    // The three actionable states must each differ from the generic one, or the fix is cosmetic.
    for (const state of ["thin", "stale", "cutoff"] as const) {
      expect(UNAVAILABLE_LABEL[state], state).not.toBe(UNAVAILABLE_LABEL.live);
    }
  });

  it("an expired option says trading is closed, which it already did", () => {
    // The one state that already had a reason. Kept, so this change did not trade one gap for another.
    const card = { ...cards.items[0]!, series: { ...cards.items[0]!.series, expiry: 1 } };
    const html = renderToStaticMarkup(createElement(PayoffCard, {
      ...base, card, quoteAsOf: cards.generatedAt, spotAvailable: true,
    }));
    expect(html).toContain("Trading closed");
  });

  it("an example card still reads as an example and not as a failure", () => {
    const html = renderToStaticMarkup(createElement(PayoffCard, {
      ...base, card: cards.items[0]!, quoteAsOf: null, spotAvailable: false, example: true,
    }));
    expect(html).toContain("Example");
  });
});
