import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PendingFeeNotice, type NextOrderBookFees } from "./PendingFeeNotice";

const nextFees: NextOrderBookFees = {
  premiumFeeBps: 450, resaleFeeBps: 125,
  takerFeeFlat: { raw: "100000", decimals: 6, formatted: "0.1" },
  takerFeeCapBps: 750, makerRebateBps: 5000, effectiveAt: Date.UTC(2026, 8, 18, 17, 30) / 1000,
};
const effectiveAt = Date.UTC(2026, 8, 18, 17, 30) / 1000;

describe("scheduled fee notice", () => {
  it("shows the buyer's next rate, effective time, and current quote check", () => {
    const html = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "buyer" }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Fee change scheduled");
    expect(html).toContain("Sep 18, 1:30 PM EDT"); // server render (and hydration) shows New York, zone named; the browser switches to the reader's zone.
    expect(html).toContain("1:30 PM EDT");
    expect(html).toContain("New taker fee: the lesser of 0.1 USDG or 7.5% of premium.");
    // One short line on when the new fee applies (OrderBook.sol: every take from effectiveAt).
    expect(html).toContain("You pay the fee in force when your trade confirms.");
  });

  it("shows the rate relevant to a writer or resale listing", () => {
    const writer = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "writer" }));
    const resale = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "resale" }));
    expect(writer).toContain("New seller fee: 4.5% of premium.");
    // A fee rate keeps its second decimal: 1.25%, never a rounded 1.2% or 1.3%.
    expect(resale).toContain("New resale fee: 1.25% of premium.");
    for (const notice of [writer, resale]) {
      expect(notice).toContain("An open order can fill under the new fees. You can cancel it first.");
      expect(notice).not.toContain("when your trade confirms");
    }
  });

  it("distinguishes crossing bid fees from resting bids and immediate resale execution", () => {
    const bid = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "bid" }));
    const sell = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "resaleImmediate" }));
    expect(bid).toContain("Any part that buys at once pays the fee in force then.");
    expect(bid).toContain("A resting bid can fill after the change");
    expect(sell).toContain("when your trade confirms");
    expect(sell).toContain("New resale fee: 1.25% of premium; new taker fee:");
  });

  it("ignores a timestamp outside the browser Date range", () => {
    expect(renderToStaticMarkup(createElement(PendingFeeNotice, {
      effectiveAt: Number.MAX_SAFE_INTEGER, nextFees, kind: "buyer",
    }))).toBe("");
  });
});
