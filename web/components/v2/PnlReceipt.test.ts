import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PnlResponse } from "@/lib/v2/api-types";
import { PnlReceipt } from "./PnlReceipt";

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname,
  "../../../ops/fixtures/api/v2/pnl/87928758254318692721909164101369622513960639781458875980445111726519827316414-0x4088c59Eb3fB713B124f182E7083AEb3358A030B.json"), "utf8")) as PnlResponse;

describe("PnL receipt", () => {
  it("describes a resale-only realised win without claiming its closing tx is a redemption", () => {
    // The wire response has no closure kind. A profitable secondary resale has the
    // same shape as a redeemed position, so every receipt must use truthful copy.
    const resaleOnly = { ...fixture, payout: { ...fixture.payout, raw: "10287200", formatted: "10.2872" }, multiple: 10 };
    const html = renderToStaticMarkup(createElement(PnlReceipt, { pnl: resaleOnly }));
    expect(html).toContain("Closing transaction");
    expect(html).toContain("sale proceeds");
    expect(html).toContain("USDG value");
    expect(html).toContain("Stock Tokens paid in kind are valued at the settlement price");
    expect(html).not.toContain("Settlement transaction");
    expect(html).not.toContain("verify the redemption");
  });
});
