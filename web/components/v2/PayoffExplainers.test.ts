import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Market } from "@/lib/v2/api-types";
import { SETTLEMENT_RULE } from "@/lib/v2/payoffReceipt";

// PayoffExplainers reads the markets (React Query) to learn whether a live market enables puts. The mock
// stands in for that one read; `markets.data` defaults to a live market with puts enabled, today's copy.
const markets = vi.hoisted(() => ({ data: [{ ticker: "NVDA", status: "live", puts: true }] as unknown }));
vi.mock("@/lib/v2/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/hooks")>()),
  useMarkets: () => ({ data: markets.data, isError: false }),
}));

import { CALLS_PAYOUT_EXPLAINER, PAYOUT_EXPLAINER, PayoffExplainers, PayoffExplainersView, SETTLEMENT_EXPLAINER } from "./PayoffExplainers";

/**
 * The two payoff explainers, pinned verbatim (shortened on purpose, same facts). The
 * settlement window (30 minutes, 16:00 New York) mirrors SETTLEMENT_WINDOW = 1800 in V2Constants and
 * ExpiryCalendar's 16:00 New York close; the "about 3 %" is MAX_PAYOUT_SLIPPAGE_CEIL_BPS = 300 in V2Constants, the worst case
 * Clearinghouse._conversionFloor allows; keeping tokens is setPayoutInKind (Clearinghouse.sol). All in
 * callhouse-contracts.
 */
describe("payoff explainers", () => {
  it("carries the settlement rule and the payout form, word for word", () => {
    expect(SETTLEMENT_EXPLAINER).toEqual({
      title: "How settlement works",
      body: "Settles on the average price of the last 30 minutes before expiry (the 16:00 New York close), not the price at that moment. The price you slide stands in for that average.",
    });
    expect(PAYOUT_EXPLAINER).toEqual({
      title: "How you get paid",
      body: "A winning put pays USDG. A winning call pays Stock Tokens. Unless you choose to keep them, they are converted to USDG at no worse than about 3 % under the settlement price, or paid as tokens if that fails. Out of the money, both expire worthless and you lose what you paid.",
    });
    // The receipt's settlement rule says the same thing: 30 minutes, 16:00 New York, not the expiry print.
    expect(SETTLEMENT_RULE).toContain("last 30 minutes before expiry (16:00 New York)");
    expect(SETTLEMENT_RULE).toContain("not on the price at the moment of expiry");
  });

  it("renders both as closed details in one labelled group, with no data and no state", () => {
    const html = renderToStaticMarkup(createElement(PayoffExplainers, { className: "mt-3" }));
    expect(html).toMatch(/^<div class="grid gap-2 sm:grid-cols-2 mt-3" aria-label="How settlement and payout work">/);
    expect(html.match(/<details /g)).toHaveLength(2);
    expect(html).not.toContain("<details open");
    expect(html).toContain(`<summary`);
    expect(html).toContain(SETTLEMENT_EXPLAINER.title);
    expect(html).toContain(SETTLEMENT_EXPLAINER.body.replace(/'/g, "&#x27;"));
    expect(html).toContain(PAYOUT_EXPLAINER.title);
    expect(html).toContain(PAYOUT_EXPLAINER.body);
    // Copy rules the dapp keeps: no yield language, no promise of a USDG figure for a call.
    for (const banned of ["APY", "APR", "guaranteed", "risk-free", "annualized", "projected yield", "rent"]) {
      expect(html.toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
    expect(PAYOUT_EXPLAINER.body).toContain("about 3 %");
  });
});

describe("the payout explainer names puts only while a live market enables them", () => {
  const withMarkets = (data: Pick<Market, "ticker" | "status" | "puts">[] | undefined) => {
    markets.data = data;
    const html = renderToStaticMarkup(createElement(PayoffExplainers));
    markets.data = [{ ticker: "NVDA", status: "live", puts: true }];
    return html;
  };

  it("pins the calls-only payout copy: the same rule, no put", () => {
    expect(CALLS_PAYOUT_EXPLAINER).toEqual({
      title: "How you get paid",
      body: "A winning call pays Stock Tokens. Unless you choose to keep them, they are converted to USDG at no worse than about 3 % under the settlement price, or paid as tokens if that fails. Out of the money, it expires worthless and you lose what you paid.",
    });
    expect(CALLS_PAYOUT_EXPLAINER.body).not.toMatch(/\bputs?\b/i);
    expect(PAYOUT_EXPLAINER.body.endsWith(CALLS_PAYOUT_EXPLAINER.body.replace("it expires", "both expire"))).toBe(true);
  });

  it("no live market with puts (off, not live, or markets unread): calls-only copy", () => {
    for (const data of [
      [{ ticker: "NVDA", status: "live" as const, puts: false }, { ticker: "SPCX", status: "live" as const, puts: false }],
      [{ ticker: "NVDA", status: "paused" as const, puts: true }],
      undefined,
    ]) {
      const html = withMarkets(data);
      expect(html, JSON.stringify(data)).toContain(CALLS_PAYOUT_EXPLAINER.body);
      expect(html, JSON.stringify(data)).not.toContain(PAYOUT_EXPLAINER.body);
      expect(html, JSON.stringify(data)).not.toMatch(/\bputs?\b/i);
    }
  });

  it("a live market with puts on: today's copy comes back unchanged", () => {
    const html = withMarkets([{ ticker: "NVDA", status: "live", puts: false }, { ticker: "SPCX", status: "live", puts: true }]);
    expect(html).toContain(PAYOUT_EXPLAINER.body);
    expect(html).not.toContain(CALLS_PAYOUT_EXPLAINER.body);
  });

  it("the pure view follows its flag", () => {
    expect(renderToStaticMarkup(createElement(PayoffExplainersView, { anyPuts: true }))).toContain(PAYOUT_EXPLAINER.body);
    expect(renderToStaticMarkup(createElement(PayoffExplainersView, { anyPuts: false }))).toContain(CALLS_PAYOUT_EXPLAINER.body);
  });
});
