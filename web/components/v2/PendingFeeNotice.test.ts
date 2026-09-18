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
    expect(html).toContain("Sep 18, 2026");
    expect(html).toContain("1:30 PM EDT");
    expect(html).toContain("0.1 USDG or 7.5% of premium");
    expect(html).toContain("The fee is set on chain when the trade executes; review the scheduled time before confirming.");
  });

  it("shows the rate relevant to a writer or resale listing", () => {
    const writer = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "writer" }));
    const resale = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "resale" }));
    expect(writer).toContain("Scheduled seller fee: 4.5% of premium.");
    expect(resale).toContain("Scheduled resale fee: 1.25% of premium.");
    for (const notice of [writer, resale]) {
      expect(notice).toContain("A resting order may fill under the new fees after activation. You can cancel it before it fills.");
      expect(notice).not.toContain("The fee is set on chain when the trade executes");
    }
  });

  it("distinguishes crossing bid fees from resting bids and immediate resale execution", () => {
    const bid = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "bid" }));
    const sell = renderToStaticMarkup(createElement(PendingFeeNotice, { effectiveAt, nextFees, kind: "resaleImmediate" }));
    expect(bid).toContain("A bid that crosses an ask uses the taker fee at execution.");
    expect(bid).toContain("A resting bid can fill after this change");
    expect(sell).toContain("The fee is set on chain when the trade executes");
    expect(sell).toContain("scheduled taker fee:");
  });

  it("ignores a timestamp outside the browser Date range", () => {
    expect(renderToStaticMarkup(createElement(PendingFeeNotice, {
      effectiveAt: Number.MAX_SAFE_INTEGER, nextFees, kind: "buyer",
    }))).toBe("");
  });
});
