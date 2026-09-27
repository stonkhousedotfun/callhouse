import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VAULT_INDICATIVE_LABEL, vaultMarkLabel } from "@/lib/v2/vaultCopy";
import { NOT_READ, VaultHero } from "./VaultHero";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Design test rule: every label is asserted present beside its value; a missing read is "not read", never 0. */
describe("VaultHero", () => {
  it("renders the mark label beside the House value and the TVL", () => {
    const label = vaultMarkLabel("Fri 12 Sep 4:00 pm ET");
    const html = renderToStaticMarkup(createElement(VaultHero, {
      title: "NVDA house vault",
      value: { text: "1.0342 USDG", label }, tvl: { text: "184,220 USDG", label },
      position: { shares: "12,000", valueAtMark: { text: "12,410 USDG", label: "at the mark" }, queued: "1 request queued (withdraw)" },
      boundary: { at: "Fri 19 Sep 4:00 pm ET", countdown: "2d 04:12", sentence: "Deposit requests before then are priced at that close." },
    }));
    expect(html).toContain("1.0342 USDG");
    expect(html.split(esc(label)).length - 1).toBe(2);
    expect(html).toContain("Fri 19 Sep 4:00 pm ET");
    expect(html).toContain('aria-live="off"');
  });

  it("renders INDICATIVE in the caution tone for an open Earn position", () => {
    const html = renderToStaticMarkup(createElement(VaultHero, {
      title: "USDG earn vault",
      value: { text: "1.0071 USDG", label: VAULT_INDICATIVE_LABEL, tone: "caution" },
      tvl: { text: "412,880 USDG", label: VAULT_INDICATIVE_LABEL, tone: "caution" },
      position: null, queueState: "Queued while a series is open · 3 ahead of you",
    }));
    expect(html).toContain(esc(VAULT_INDICATIVE_LABEL));
    expect(html).toContain("text-warn");
    expect(html).toContain("3 ahead of you");
    expect(html).toContain("Connect a wallet");
  });

  it("a value that was not read says so and never renders 0", () => {
    const html = renderToStaticMarkup(createElement(VaultHero, {
      title: "x", value: { text: null, label: "L" }, tvl: { text: null, label: "L" }, position: { shares: null, valueAtMark: null, queued: null },
    }));
    expect(html.split(NOT_READ).length - 1).toBe(3);
    expect(html).not.toMatch(/>0</);
  });
});
