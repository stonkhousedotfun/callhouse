import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SETTLEMENT_RULE } from "@/lib/v2/payoffReceipt";

import { PAYOUT_EXPLAINER, PayoffExplainers, SETTLEMENT_EXPLAINER } from "./PayoffExplainers";

/**
 * T-OP-120. The two explainers of design §2.6, pinned verbatim. The settlement window (30 minutes, 16:00 New
 * York) mirrors V2Constants.sol:44 SETTLEMENT_WINDOW = 1800 at callhouse-contracts v8 ee14bfbc; the "about 3 %"
 * is MAX_PAYOUT_SLIPPAGE_CEIL_BPS = 300 (V2Constants.sol:88), the worst case Clearinghouse._conversionFloor allows.
 */
describe("payoff explainers", () => {
  it("carries the settlement rule and the payout form, word for word", () => {
    expect(SETTLEMENT_EXPLAINER).toEqual({
      title: "How settlement works",
      body: "This option settles on the average price of the last 30 minutes before expiry (the 16:00 New York close), from the market's price sources — not on the price at the moment of expiry. The price you slide here stands in for that average.",
    });
    expect(PAYOUT_EXPLAINER).toEqual({
      title: "How you get paid",
      body: "A winning put pays USDG. A winning call pays Stock Tokens (a fraction of a share). Unless you choose to keep tokens, the app tries to convert them to USDG at no worse than about 3 % under the settlement price and hands you the tokens if that is not possible. Out of the money, both expire worthless and you lose exactly what you paid.",
    });
    // The receipt's settlement rule says the same thing (§1.1): 30 minutes, 16:00 New York, not the expiry print.
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
    // Copy rules the dapp keeps (web/README.md): no yield language, no promise of a USDG figure for a call.
    for (const banned of ["APY", "APR", "guaranteed", "risk-free", "annualized", "projected yield", "rent"]) {
      expect(html.toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
    expect(PAYOUT_EXPLAINER.body).toContain("about 3 %");
  });
});
