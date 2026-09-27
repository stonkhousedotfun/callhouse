/**
 * The five destinations and the active rule. The header row and the phone tab bar both read this, so
 * the rendered tests (components/v2/NavFiveEntries.test.ts, components/TabBar.test.ts) only have to prove they use
 * it; the routing table itself is pinned here.
 */
import { describe, expect, it } from "vitest";

import { V2_NAV_ENTRIES, activeV2Href, normalisePath } from "./navEntries";

const TICKERS = ["NVDA", "SPCX"];
const label = (pathname: string) => V2_NAV_ENTRIES.find((e) => e.href === activeV2Href(pathname, TICKERS))?.label ?? null;

describe("V2_NAV_ENTRIES", () => {
  it("is Options (was Buy), Portfolio, Vaults, Wins, Markets, in the mockups' order", () => {
    expect(V2_NAV_ENTRIES.map((e) => [e.label, e.href])).toEqual([
      ["Options", "/"],
      ["Portfolio", "/portfolio"],
      ["Vaults", "/vaults"],
      ["Wins", "/wins"],
      ["Markets", "/trust/markets"],
    ]);
  });
});

describe("activeV2Href", () => {
  it.each([
    ["/", "Options"],
    ["/nvda", "Options"],
    ["/NVDA/", "Options"],
    ["/spcx/some-series", "Options"],
    ["/portfolio", "Portfolio"],
    ["/portfolio/history", "Portfolio"],
    ["/vaults", "Vaults"],
    ["/earn", "Vaults"],
    ["/earn/rewards", "Vaults"],
    ["/lend", "Vaults"],
    ["/house/nvda", "Vaults"],
    // Sell options (the writer pages that were /earn) lights Buy, not Vaults.
    ["/sell", "Options"],
    ["/sell/spcx", "Options"],
    ["/wins", "Wins"],
    ["/trust/markets", "Markets"],
    ["/trust", "Markets"],
    ["/trust/burns", "Markets"],
  ])("%s lights %s", (pathname, want) => {
    expect(label(pathname)).toBe(want);
  });

  it.each(["/docs", "/legal", "/nvda/account", "/nvda/book", "/winsome", "/trusty", "/nvdax", "/seller"])(
    "%s lights nothing (a prefix is a path segment, not a string prefix)",
    (pathname) => {
      expect(activeV2Href(pathname, TICKERS)).toBeNull();
    },
  );

  it("a market page lights Options only for a listed ticker -- the control for /nvda above", () => {
    expect(activeV2Href("/nvda", [])).toBeNull();
  });
});

describe("normalisePath", () => {
  it("drops trailing slashes and case, keeps the root", () => {
    expect(normalisePath("/Wins//")).toBe("/wins");
    expect(normalisePath("/")).toBe("/");
    expect(normalisePath(null)).toBe("/");
  });
});
