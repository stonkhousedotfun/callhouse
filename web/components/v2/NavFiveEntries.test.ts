/**
 * The app nav is five entries, and /markets -- a
 * second door beside Buy into the same room -- became "Market status" under Trust.
 *
 * UPDATED ON PURPOSE. A pre-launch change renamed the fifth entry
 * from Trust (/trust) to Markets (/trust/markets), made /trust itself redirect to /trust/markets, and replaced the
 * market picker's search box and its "Browse all markets" link with one button per market. This file was not
 * updated with it and had six failing cases before this update. The Neon mockups name the fifth tab Markets too. The
 * expectations below now say Markets; the invariants did not change: five entries, the market status page is the
 * fifth, /markets is never linked, and wherever the reader is inside the five exactly one entry is lit.
 *
 * The nav is RENDERED here rather than grepped. Which entries exist is a list, but which one is lit
 * is behaviour -- NavLinks decides it from the pathname -- and that half is what a source assertion
 * cannot see: /trust/markets must light Trust, or a reader who follows "Market status" lands on a
 * page with no entry marked current. usePathname is mocked; everything else runs as shipped. The
 * two route modules are called directly, with the navigation helpers they use replaced by ones that
 * record and throw, the way Next's own throw to stop rendering.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import MarketsRedirect from "@/app/markets/page";
import sitemap from "@/app/sitemap";
import MarketStatusPage, { metadata as marketStatusMetadata } from "@/app/trust/markets/page";
import { NavLinks } from "@/components/NavLinks";
import { APP_URL } from "@/lib/site";
import { MarketDirectory } from "./MarketDirectory";

const nav = vi.hoisted(() => ({ pathname: "/" as string | null, redirectedTo: null as string | null }));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => nav.pathname,
  permanentRedirect: (to: string) => {
    nav.redirectedTo = to;
    throw new Error(`permanentRedirect(${to})`);
  },
  notFound: () => {
    throw new Error("notFound()");
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  nav.pathname = "/";
  nav.redirectedTo = null;
});

type Entry = { label: string; href: string | undefined; current: boolean };

/** The in-app entries NavLinks renders at `pathname`, in order. The new-tab site link is not one. */
function entries(pathname: string, v2 = true): Entry[] {
  vi.stubEnv("NEXT_PUBLIC_V2", v2 ? "1" : "");
  nav.pathname = pathname;
  const html = renderToStaticMarkup(createElement(NavLinks));
  return [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)]
    .filter(([, attrs]) => !attrs.includes('target="_blank"'))
    .map(([, attrs, label]) => ({
      label,
      href: /\bhref="([^"]*)"/.exec(attrs)?.[1],
      current: attrs.includes('aria-current="page"'),
    }));
}

const lit = (pathname: string) => entries(pathname).filter((entry) => entry.current).map((entry) => entry.label);

describe("the app nav is five entries", () => {
  it("the nav was actually rendered -- the control", () => {
    // Without this, a regex that matched nothing would make every "not" below pass vacuously.
    expect(entries("/").length).toBeGreaterThan(0);
  });

  it("offers Options, Portfolio, Vaults, Wins and Markets, in that order, and nothing else", () => {
    expect(entries("/").map(({ label, href }) => [label, href])).toEqual([
      ["Options", "/"],
      ["Portfolio", "/portfolio"],
      ["Vaults", "/vaults"],
      ["Wins", "/wins"],
      ["Markets", "/trust/markets"],
    ]);
  });

  it("Markets is the market status page, never the /markets redirect (the second door beside Buy)", () => {
    const all = entries("/");
    expect(all.map((entry) => entry.href)).not.toContain("/markets");
    expect(all.find((entry) => entry.label === "Markets")?.href).toBe("/trust/markets");
  });

  it("has no link that leaves the app", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    const html = renderToStaticMarkup(createElement(NavLinks));
    expect(html.match(/target="_blank"/g) ?? []).toHaveLength(0);
    expect(html).not.toMatch(/href="https?:/);
    // Buy still points home; the brand logo (components/ui/Brand.tsx) is untouched and also links home.
    expect(html).toContain('href="/"');
  });
});

describe("aria-current marks exactly one entry, wherever the reader is", () => {
  it("lights Markets on Market status, the page /markets became", () => {
    expect(lit("/trust/markets")).toEqual(["Markets"]);
  });

  it.each([
    ["/", "Options"],
    ["/nvda", "Options"],
    ["/portfolio", "Portfolio"],
    ["/vaults", "Vaults"],
    ["/earn", "Vaults"],
    ["/lend", "Vaults"],
    ["/house", "Vaults"],
    // Sell options is the market pages' other side, not a vault.
    ["/sell", "Options"],
    ["/sell/nvda", "Options"],
    ["/wins", "Wins"],
    // /trust redirects to /trust/markets; Markets is the nav's only door into the /trust section.
    ["/trust", "Markets"],
    ["/trust/burns", "Markets"],
  ])("%s lights %s and nothing else", (pathname, label) => {
    expect(lit(pathname)).toEqual([label]);
  });
});

describe("the v1 nav is untouched", () => {
  it("still offers its depositor links", () => {
    expect(entries("/", false).map((entry) => entry.label)).toEqual(["Home", "Account", "Book", "Docs", "Legal"]);
  });
});

describe("/markets moved to /trust/markets", () => {
  it("/markets permanently redirects there on v2", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    expect(() => MarketsRedirect()).toThrow("permanentRedirect(/trust/markets)");
    expect(nav.redirectedTo).toBe("/trust/markets");
  });

  it("/markets is still a 404 on v1, where it never existed", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "");
    expect(() => MarketsRedirect()).toThrow("notFound()");
    expect(nav.redirectedTo).toBeNull();
  });

  it("/trust/markets renders the market directory and is canonical at its own address", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    expect(MarketStatusPage().type).toBe(MarketDirectory);
    expect(marketStatusMetadata.alternates?.canonical).toBe("/trust/markets");
    expect(String(marketStatusMetadata.title)).toMatch(/^Market status\b/);
  });

  it("the sitemap lists the new address and not the redirect", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${APP_URL}/trust/markets`);
    expect(urls).not.toContain(`${APP_URL}/markets`);
  });

  it("the market picker never links the /markets redirect", () => {
    // Since the rename the picker is one button per market and links nowhere; the old "Browse all markets" link, which
    // this case used to pin to /trust/markets, is gone. What still matters is that nothing sends a reader through
    // the redirect.
    const picker = readFileSync(fileURLToPath(new URL("./MarketPicker.tsx", import.meta.url)), "utf8");
    expect(picker, "the picker source was read -- the control").toContain("export function MarketPicker");
    expect(picker).not.toContain('href="/markets"');
  });
});
