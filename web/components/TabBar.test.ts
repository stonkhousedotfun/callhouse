/**
 * The phone tab bar. The routing table is pinned in lib/ui/navEntries.test.ts; this proves the bar
 * renders those five with one lit, clears 44px, hides from 1024px, carries the sticky-buy-bar slot, and is v2 only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ pathname: "/" as string | null }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => nav.pathname,
}));

import { STICKY_BUY_BAR_ID, StickyBuyBar, TabBar, TabBarView } from "./TabBar";

afterEach(() => {
  vi.unstubAllEnvs();
  nav.pathname = "/";
});

const view = (pathname: string) => renderToStaticMarkup(createElement(TabBarView, { pathname }));
const tabs = (html: string) => [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map(([, attrs, inner]) => ({
  label: inner.replace(/<svg[\s\S]*?<\/svg>/g, ""),
  href: /\bhref="([^"]*)"/.exec(attrs)?.[1],
  current: attrs.includes('aria-current="page"'),
  classes: /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? "",
}));

describe("TabBar", () => {
  it("offers the five, in the mockups' order", () => {
    expect(tabs(view("/")).map(({ label, href }) => [label, href])).toEqual([
      ["Options", "/"],
      ["Portfolio", "/portfolio"],
      ["Vaults", "/vaults"],
      ["Wins", "/wins"],
      ["Markets", "/trust/markets"],
    ]);
  });

  it.each([
    ["/", "Options"],
    ["/nvda", "Options"],
    ["/earn", "Vaults"],
    ["/sell/nvda", "Options"],
    ["/trust/markets", "Markets"],
    ["/wins", "Wins"],
  ])("%s lights exactly %s, in --accent-text", (pathname, label) => {
    const lit = tabs(view(pathname)).filter((tab) => tab.current);
    expect(lit.map((tab) => tab.label)).toEqual([label]);
    expect(lit[0].classes).toContain("text-accent-text");
  });

  it("lights nothing off the five (/docs) -- the control for the table above", () => {
    expect(tabs(view("/docs")).filter((tab) => tab.current)).toEqual([]);
  });

  it("every tab is at least 44px, and the icons are decorative", () => {
    const html = view("/");
    for (const tab of tabs(html)) expect(tab.classes).toContain("min-h-11");
    expect(html.match(/<svg aria-hidden="true"/g)).toHaveLength(5);
  });

  it("is fixed to the bottom and gone from 1024px, with the safe area under it", () => {
    const html = view("/");
    const bar = /<div data-slot="tab-bar" class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(bar).toContain("fixed");
    expect(bar).toContain("bottom-0");
    expect(bar).toContain("lg:hidden");
    expect(bar).toContain("safe-area-inset-bottom");
  });

  it("carries the sticky buy bar slot above the tabs", () => {
    const html = view("/");
    expect(html).toContain(`id="${STICKY_BUY_BAR_ID}"`);
    expect(html.indexOf(STICKY_BUY_BAR_ID)).toBeLessThan(html.indexOf("<nav"));
  });

  it("renders on v2 only", () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    expect(renderToStaticMarkup(createElement(TabBar))).toContain('data-slot="tab-bar"');
    vi.stubEnv("NEXT_PUBLIC_V2", "");
    expect(renderToStaticMarkup(createElement(TabBar))).toBe("");
  });
});

describe("StickyBuyBar", () => {
  it("leaves an in-flow spacer and renders nothing into the slot on the server", () => {
    const html = renderToStaticMarkup(createElement(StickyBuyBar as never, { height: 64 }, "Buy $236 call"));
    expect(html).toBe('<div aria-hidden="true" class="lg:hidden" style="height:64px"></div>');
  });
});
