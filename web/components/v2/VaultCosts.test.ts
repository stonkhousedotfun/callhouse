import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { feeRouteLine, houseFeeLine } from "@/lib/v2/vaultCopy";
import { rateExceedsCeiling, VaultCosts } from "./VaultCosts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;");
const base = {
  vaultFeeLine: houseFeeLine(0, 2000), rateBps: 0, ceilBps: 2000, highWaterMark: "1.0342 USDG / share",
  protocol: [{ label: "Seller fee on premium", value: "5.00 %" }, { label: "Exercise fee", value: null }],
  feeRoute: feeRouteLine(5000), feeDelaySentence: "Fee changes wait 48 h after being scheduled.",
};

describe("VaultCosts", () => {
  it("renders the read-built fee line, the HWM, protocol fees and the route", () => {
    const html = renderToStaticMarkup(createElement(VaultCosts, base));
    expect(html).toContain(esc(houseFeeLine(0, 2000)!));
    expect(html).toContain("1.0342 USDG / share");
    expect(html).toContain("5.00 %");
    expect(html).toContain("not read");
    expect(html).toContain(esc(feeRouteLine(5000)!));
    expect(html).not.toContain('role="alert"');
  });

  it("says 'not read' when the fee read failed, and flags a rate above its ceiling", () => {
    const missing = renderToStaticMarkup(createElement(VaultCosts, { ...base, vaultFeeLine: null, feeRoute: null }));
    expect(missing).toContain("Vault fee: not read.");
    expect(missing).toContain("Fee route: not read.");
    const bad = renderToStaticMarkup(createElement(VaultCosts, { ...base, rateBps: 2500 }));
    expect(bad).toContain('role="alert"');
    expect(rateExceedsCeiling(2500, 2000)).toBe(true);
    expect(rateExceedsCeiling(null, 2000)).toBe(false);
  });
});
