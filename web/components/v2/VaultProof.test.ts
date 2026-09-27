import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { addressUrl, tokenUrl, txUrl } from "@/lib/chain";
import { proofHref, VaultProof } from "./VaultProof";

const a = "0x0000000000000000000000000000000000000066";
const tx = `0x${"ab".repeat(32)}`;

describe("VaultProof", () => {
  it("links each kind through lib/chain and never links a row that was not read", () => {
    expect(proofHref({ label: "Vault", kind: "address", value: a })).toBe(addressUrl(a));
    expect(proofHref({ label: "Shares", kind: "token", value: a })).toBe(tokenUrl(a));
    expect(proofHref({ label: "Last boundary", kind: "tx", value: tx })).toBe(txUrl(tx));
    expect(proofHref({ label: "Splitter", kind: "address", value: null })).toBeNull();
    const html = renderToStaticMarkup(createElement(VaultProof, { rows: [
      { label: "Vault", kind: "address", value: a, note: "ERC-20 shares" },
      { label: "Fee splitter", kind: "address", value: null },
    ] }));
    expect(html).toContain(addressUrl(a));
    expect(html).toContain("ERC-20 shares");
    expect(html).toContain("not read");
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});
