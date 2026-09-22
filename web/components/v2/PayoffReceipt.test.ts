import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, costToBuy } from "@/lib/v2/payoff";
import { buildPayoffReceipt, type PayoffReceiptInput } from "@/lib/v2/payoffReceipt";

import { PayoffReceipt } from "./PayoffReceipt";

/**
 * T-OP-120. The receipt component (design §2.5, §2.7) at the design example ticket: 300 units at 4.1333 USDG/share,
 * strike 230 call, exercise fee 25 bps, settlement 240, conversion at the contract ceiling. The figures themselves
 * are pinned in lib/v2/payoffReceipt.test.ts; this file pins that the markup renders every line the builder
 * produced, in order, with its note and its rule, and that the server render is collapsed with the total visible.
 */
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const quote = costToBuy([{ orderId: "1", price: 4_133_300n, units: 300n }], 300n, fees);
const call = { isPut: false, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
const put = { isPut: true, strike: 230_000_000n, units: 300n, exerciseFeeBps: 25 };
const ceiling = { slippageBps: MAX_PAYOUT_SLIPPAGE_CEIL_BPS, routeFeeBps: MAX_ROUTE_FEE_BPS };
const input: PayoffReceiptInput = { ticker: "NVDA", position: call, cost: quote, fees, price: 240_000_000n, terms: ceiling, gas: null };

function render(receiptInput: PayoffReceiptInput): string {
  return renderToStaticMarkup(createElement(PayoffReceipt, { input: receiptInput }));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "|").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, "\"");
}

describe("payoff receipt markup", () => {
  it("is a details element, collapsed on the server, whose summary carries the total and the net at this price", () => {
    const html = render(input);
    expect(html).toMatch(/^<details class="rounded-md border border-line bg-surface " data-testid="payoff-receipt">/);
    expect(html).not.toContain("<details open");
    expect(html).toContain("What you pay, and what you can get");
    expect(html).toContain("Total 12.50 USDG · at $240.00: +14.85 to +15.69 USDG");
    // The effect that opens it on a desktop viewport is a client concern; the source pins the breakpoint.
    const source = readFileSync(resolve(import.meta.dirname, "PayoffReceipt.tsx"), "utf8");
    expect(source).toContain('window.matchMedia("(min-width: 640px)").matches');
  });

  it("renders the design example call: every builder line, in order, with its value, note and rule", () => {
    const html = render(input);
    const flat = text(html);
    const receipt = buildPayoffReceipt(input);
    const lines = [...receipt.pay.lines, receipt.pay.total, ...receipt.get.lines, receipt.get.total];
    let cursor = 0;
    for (const line of lines) {
      const at = flat.indexOf(line.label, cursor);
      expect(at, line.key).toBeGreaterThan(cursor - 1);
      cursor = at;
      for (const part of [line.value, line.note, line.rule]) {
        const found = flat.indexOf(part, cursor);
        expect(found, `${line.key}: ${part}`).toBeGreaterThan(-1);
      }
    }
    expect(flat).toContain(receipt.pay.title);
    expect(flat).toContain("What you can get at settlement (if NVDA ends at $240.00; strike 230.00 call)");
    // The known ticket, line by line (§2.5), as the reader sees it.
    for (const snippet of [
      "Premium|", "12.40 USDG", "300 × 0.01-share units at 4.1333 USDG/share average ask",
      "Taker fee|", "0.10 USDG", "the lesser of 0.10 USDG or 10 % of premium (1.24)",
      "Network gas|", "shown by your wallet",
      "Total = your max loss|", "12.50 USDG",
      "Gross payout|", "0.124999 NVDA", "3 shares × (240.00 − 230.00) ÷ 240.00",
      "Exercise fee|", "− 0.007500 NVDA", "0.25 % of the 3 shares locked, never more than 10 % of the payout",
      "Net payout|", "0.117499 NVDA",
      "As USDG|", "between 27.35 and 28.19 USDG", "worth 28.19 at the settlement price; at worst about 3 % under it (the contract ceiling), or the tokens themselves",
      "Redeem gas|", "usually paid by a keeper",
      "Net P&L|", "+14.85 to +15.69 USDG (+118 % to +125 %, 2.18× to 2.25×)",
    ]) expect(flat, snippet).toContain(snippet);
    // A deduction carries a leading minus in the figure column; the only deduction here is the exercise fee.
    expect(flat.match(/\|− /g)).toHaveLength(1);
  });

  it("gives every line an info toggle that names the rule and is closed until pressed", () => {
    const html = render(input);
    const receipt = buildPayoffReceipt(input);
    const count = receipt.pay.lines.length + 1 + receipt.get.lines.length + 1;
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(count);
    expect(html.match(/<p id="[^"]+" hidden=""/g)).toHaveLength(count);
    expect(html).toContain('aria-label="How premium is calculated"');
    expect(html).toContain('aria-label="How net p&amp;l is calculated"');
    // Rules are written from the contract, never as a file path.
    expect(html).not.toMatch(/\.sol|\.tsx?\b/);
  });

  it("renders a put with one USDG figure and a wallet gas estimate", () => {
    const flat = text(render({ ...input, position: put, price: 220_000_000n, gas: { transactions: 2, wei: 21_000_000_000_000n, symbol: "ETH" } }));
    expect(flat).toContain("strike 230.00 put)");
    expect(flat).toContain("≈ 0.000021 ETH");
    expect(flat).toContain("2 transactions now (wallet estimate)");
    expect(flat).toContain("Paid as|");
    expect(flat).toContain("+15.77 USDG (+126 %, 2.26×)");
    expect(flat).not.toContain("As USDG");
    expect(flat).not.toContain("NVDA|");
  });
});
