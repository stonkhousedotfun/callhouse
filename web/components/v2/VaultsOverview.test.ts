/**
 * W5, plan gap 9: the three vault surfaces collapse into one nav entry and one index page.
 *
 * WHAT IS PINNED HERE. Two things a reader depends on and a refactor can silently drop:
 * every vault states BOTH what goes in and when it comes back out (that pairing is the whole
 * reason the page exists), and the Lend row says its vault is not deployed rather than showing an
 * empty figure a reader would take for zero. The plan's words are "Plan for it; do not fake it".
 *
 * The nav half is a source assertion because the defect IS the link list: there is no behaviour to
 * render for a list of hrefs, and the same file's own comment legitimately discusses the routes it
 * collapsed, so the assertion looks at the V2 link array rather than grepping the whole source --
 * the mistake Nav.test.ts documents making.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VaultsOverview } from "./VaultsOverview";

const navSource = readFileSync(fileURLToPath(new URL("../NavLinks.tsx", import.meta.url)), "utf8");

/** The V2 branch's link array alone, so the surrounding prose cannot satisfy or break the match. */
const v2Links = (() => {
  const at = navSource.indexOf('{ href: "/", label: "Buy" }');
  return navSource.slice(at, navSource.indexOf("]", at));
})();

describe("the vaults index", () => {
  const html = renderToStaticMarkup(createElement(VaultsOverview));

  it("names all three surfaces and links to each", () => {
    for (const [name, href] of [["Earn", "/earn"], ["Lend", "/lend"], ["House", "/house"]] as const) {
      expect(html).toContain(`>${name}<`);
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("states BOTH what goes in and when it comes out, for every vault", () => {
    expect(html.match(/You deposit/g) ?? []).toHaveLength(3);
    expect(html.match(/You can withdraw/g) ?? []).toHaveLength(3);
  });

  it("says the lending vault is not deployed instead of showing a figure for it", () => {
    expect(html).toMatch(/lending vault is not deployed/i);
  });

  it("quotes no figure at all, since the three surfaces source theirs differently", () => {
    // A currency amount or a percentage anywhere on this index would have to come from somewhere,
    // and Lend has nowhere to get one. Each surface shows its own numbers on its own page.
    expect(html).not.toMatch(/\$\d|\d+(\.\d+)?\s*%|\bUSDG\s+\d/);
  });
});

describe("the nav collapses the three vault entries into one", () => {
  it("offers Vaults and no longer offers Earn, Lend or House as top-level entries", () => {
    expect(v2Links).toContain('{ href: "/vaults", label: "Vaults" }');
    for (const gone of ['label: "Earn"', 'label: "Lend"', 'label: "House"']) {
      expect(v2Links).not.toContain(gone);
    }
  });

  it("keeps the Vaults entry lit on the three routes it stands for", () => {
    expect(navSource).toContain('const VAULT_ROUTES = ["/earn", "/lend", "/house"] as const;');
    expect(navSource).toContain('link.href === "/vaults" && VAULT_ROUTES.some(');
  });
});
