import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EARN_RISKS, houseRisks } from "@/lib/v2/vaultCopy";
import { VaultRisks } from "./VaultRisks";

describe("VaultRisks", () => {
  it("renders every row's term, words and bound", () => {
    const rows = houseRisks("weekly", "NVDA");
    const html = renderToStaticMarkup(createElement(VaultRisks, { risks: rows }));
    for (const r of rows) expect(html).toContain(r.term);
    expect(html).toContain("Weekly lock");
    expect(html.match(/<dt/g)).toHaveLength(rows.length);
  });
  it("renders the Earn set", () => {
    const html = renderToStaticMarkup(createElement(VaultRisks, { risks: EARN_RISKS }));
    expect(html).toContain("Covered-call cap");
  });
});
