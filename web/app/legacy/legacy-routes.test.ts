/**
 * The /legacy/* wiring: what each server page decides, not its markup. The layout 404s outside the v2 build and
 * mounts the freeze banner with the registry's dates; /legacy is noindex and links every legacy market's account and
 * book; /legacy/<ticker>/{account,book} are static for the deployed v1 factories only, resolve the ticker in any case,
 * 404 anything else, and mount the v1 view for that market; the retired cycle page redirects to the default book.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountView } from "@/components/AccountView";
import { BookView } from "@/components/BookView";
import { FreezeBanner } from "@/components/legacy/FreezeBanner";
import { MigrationGuide } from "@/components/legacy/MigrationGuide";
import { LEGACY_MARKETS } from "@/lib/legacy";
import { DEFAULT_MARKET } from "@/lib/markets";
import LegacyLayout, { metadata as layoutMetadata } from "./layout";
import LegacyPage, { metadata as legacyMetadata } from "./page";
import { legacyDefaultPath, legacyMarketPath, legacyVaultPath } from "./routes";
import * as accountPage from "./[ticker]/account/page";
import * as bookPage from "./[ticker]/book/page";
import CycleRedirect from "./vault/nvda/cycle/page";

vi.mock("@/components/legacy/MigrationGuide", async () => {
  const { createElement: h } = await vi.importActual<typeof import("react")>("react");
  return { MigrationGuide: () => h("i", null, "[MigrationGuide]") };
});

/** Run a server page and report what Next would do with it. */
async function outcome(f: () => unknown): Promise<{ value?: unknown; redirect?: string; status?: number; notFound?: boolean }> {
  try {
    return { value: await f() };
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT;")) {
      const parts = digest.split(";");
      return { redirect: parts.slice(2, -2).join(";"), status: Number(parts.at(-2)) };
    }
    if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) return { notFound: true };
    throw error;
  }
}
const params = (ticker: string) => ({ params: Promise.resolve({ ticker }) });

afterEach(() => { vi.unstubAllEnvs(); });

describe("routes.ts", () => {
  it("lowercases the ticker; the default market and the vault path are fixed", () => {
    expect(legacyMarketPath("NVDA", "account")).toBe("/legacy/nvda/account");
    expect(legacyMarketPath("Spcx", "book")).toBe("/legacy/spcx/book");
    expect(legacyDefaultPath("book")).toBe(`/legacy/${DEFAULT_MARKET.ticker.toLowerCase()}/book`);
    expect(legacyVaultPath()).toBe("/legacy/vault/nvda");
    expect(legacyVaultPath("/cycle")).toBe("/legacy/vault/nvda/cycle");
  });
});

describe("/legacy layout", () => {
  it("404s outside the v2 build", async () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "");
    expect(await outcome(() => LegacyLayout({ children: "x" }))).toEqual({ notFound: true });
  });

  it("v2: the freeze banner with each legacy market's registry date, then the page; noindex, follow", async () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    const { value } = await outcome(() => LegacyLayout({ children: "PAGE" }));
    const kids = (value as ReactElement<{ children: ReactNode[] }>).props.children;
    const banner = kids[0] as ReactElement<{ dates: Record<string, number | null> }>;
    expect(banner.type).toBe(FreezeBanner);
    expect(Object.keys(banner.props.dates)).toEqual(LEGACY_MARKETS.map((m) => m.ticker));
    expect(kids[1]).toBe("PAGE");
    expect(layoutMetadata.robots).toEqual({ index: false, follow: true });
  });
});

describe("/legacy", () => {
  it("noindex, mounts the migration guide, and links each legacy market's account and book plus collect and activity", () => {
    expect(legacyMetadata.robots).toEqual({ index: false, follow: true });
    const html = renderToStaticMarkup(createElement(LegacyPage));
    expect(html).toContain("[MigrationGuide]");
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    for (const m of LEGACY_MARKETS) {
      expect(hrefs).toContain(`/legacy/${m.ticker.toLowerCase()}/account`);
      expect(hrefs).toContain(`/legacy/${m.ticker.toLowerCase()}/book`);
    }
    expect(hrefs).toEqual(expect.arrayContaining(["/", "/legacy/collect", "/legacy/activity"]));
    expect(MigrationGuide).toBeTypeOf("function");
  });
});

for (const [name, page, View, words] of [
  ["account", accountPage, AccountView, "Settle and withdraw from your legacy NVDA writer account."],
  ["book", bookPage, BookView, "Exercise an existing legacy NVDA call during its option window."],
] as const) {
  describe(`/legacy/[ticker]/${name}`, () => {
    it("static params are the deployed v1 factories only, lowercased, and nothing else renders", () => {
      expect(page.dynamicParams).toBe(false);
      expect(page.generateStaticParams()).toEqual(LEGACY_MARKETS.map((m) => ({ ticker: m.ticker.toLowerCase() })));
    });

    it("metadata names the market; an unknown ticker is 'Not found'", async () => {
      expect(await page.generateMetadata(params("nvda"))).toEqual({ title: `NVDA ${name} — StonkHouse`, description: words });
      expect(await page.generateMetadata(params("zzzz"))).toEqual({ title: "Not found — StonkHouse" });
    });

    it("mounts the v1 view for that market (ticker in any case); an unknown ticker 404s", async () => {
      for (const t of ["nvda", "NVDA"]) {
        const el = (await outcome(() => page.default(params(t)))).value as ReactElement<{ market: { ticker: string; factory: string } }>;
        expect(isValidElement(el)).toBe(true);
        expect(el.type).toBe(View);
        expect(el.props.market).toBe(LEGACY_MARKETS[0]);
      }
      expect(await outcome(() => page.default(params("spcx")))).toEqual({ notFound: true });
      expect(await outcome(() => page.default(params("../x")))).toEqual({ notFound: true });
    });
  });
}

describe("/legacy/vault/nvda/cycle", () => {
  it("redirects (temporary) to the default market's legacy book in v2, and to /book in v1", async () => {
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    expect(await outcome(() => CycleRedirect())).toEqual({ redirect: legacyDefaultPath("book"), status: 307 });
    vi.stubEnv("NEXT_PUBLIC_V2", "0");
    expect(await outcome(() => CycleRedirect())).toEqual({ redirect: "/book", status: 307 });
  });
});
