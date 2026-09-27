/**
 * The thin route pages under app/: what each decides, not its markup. v2-only pages 404 in the v1 build and mount
 * their component in v2; the old v1 addresses redirect (permanently to /legacy/* in v2, temporarily to the default
 * market in v1) or keep rendering the v1 page; public buyer pages carry PUBLIC_V2_ROBOTS (indexable only in the
 * non-preview v2 build) and private ones are always noindex. Also the /pnl/[id] receipt page and the /legal TOC.
 *
 * Module-level constants read the environment at import (lib/devPreview.ts), so the robots cases re-import after
 * stubbing it.
 */
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MARKET } from "@/lib/markets";

vi.mock("@/components/v2/PnlData", async (orig) => ({ ...(await orig<typeof import("@/components/v2/PnlData")>()), loadPnl: vi.fn() }));
vi.mock("next/font/google", () => ({ Plus_Jakarta_Sans: () => ({ variable: "--sans" }), JetBrains_Mono: () => ({ variable: "--mono" }) }));

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
const typeOf = (o: { value?: unknown }) => (o.value as ReactElement).type;
const PRIVATE = { index: false, follow: true };

afterEach(() => { vi.unstubAllEnvs(); });

describe("v2-only pages: 404 in v1, their component in v2", () => {
  const cases: Array<[string, () => Promise<{ default: () => unknown }>, () => Promise<unknown>, Record<string, unknown>?]> = [
    ["/leaderboard", () => import("./leaderboard/page"), async () => (await import("@/components/v2/WinsLeaderboard")).WinsAndLeaderboard, { initialTab: "leaderboard" }],
    ["/wins", () => import("./wins/page"), async () => (await import("@/components/v2/WinsLeaderboard")).WinsAndLeaderboard, { initialTab: "wins" }],
    ["/makers", () => import("./makers/page"), async () => (await import("@/components/v2/MakersPage")).MakersPage],
    ["/portfolio", () => import("./portfolio/page"), async () => (await import("@/components/v2/Portfolio")).Portfolio],
    ["/settings/notifications", () => import("./settings/notifications/page"), async () => (await import("@/components/v2/NotificationSettings")).NotificationSettings],
    ["/vaults", () => import("./vaults/page"), async () => (await import("@/components/v2/VaultsOverview")).VaultsOverview],
    ["/house", () => import("./house/page"), async () => (await import("@/components/v2/HouseOverview")).HouseOverview],
    ["/sell", () => import("./sell/page"), async () => (await import("@/components/v2/EarnOverview")).EarnOverview],
    ["/trust/markets", () => import("./trust/markets/page"), async () => (await import("@/components/v2/MarketDirectory")).MarketDirectory],
  ];
  for (const [route, load, component, props] of cases) {
    it(route, async () => {
      const page = (await load()).default;
      vi.stubEnv("NEXT_PUBLIC_V2", "");
      expect(await outcome(page)).toEqual({ notFound: true });
      vi.stubEnv("NEXT_PUBLIC_V2", "1");
      const out = await outcome(page);
      expect(typeOf(out)).toBe(await component());
      if (props) expect((out.value as ReactElement).props).toEqual(props);
    });
  }

  it("/trust moved to the docs: 404 in v1, a permanent redirect to /trust/markets in v2", async () => {
    const { default: page } = await import("./trust/page");
    vi.stubEnv("NEXT_PUBLIC_V2", "");
    expect(await outcome(page)).toEqual({ notFound: true });
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    expect(await outcome(page)).toEqual({ redirect: "/trust/markets", status: 308 });
  });
});

describe("/ mounts the marketplace in v2 and the v1 home otherwise", () => {
  it("picks by NEXT_PUBLIC_V2 at request time", async () => {
    const { default: Home } = await import("./page");
    const { Marketplace } = await import("@/components/v2/Marketplace");
    const { default: LegacyHome } = await import("./legacy/LegacyHome");
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    expect((Home() as ReactElement).type).toBe(Marketplace);
    vi.stubEnv("NEXT_PUBLIC_V2", "0");
    expect((Home() as ReactElement).type).toBe(LegacyHome);
  });
});

describe("old v1 addresses", () => {
  const ticker = DEFAULT_MARKET.ticker.toLowerCase();

  it("/account and /book: permanent to the legacy default market in v2, temporary to /<ticker>/… in v1", async () => {
    for (const [load, section] of [[() => import("./account/page"), "account"], [() => import("./book/page"), "book"]] as const) {
      const page = (await load()).default;
      vi.stubEnv("NEXT_PUBLIC_V2", "1");
      expect(await outcome(page)).toEqual({ redirect: `/legacy/${ticker}/${section}`, status: 308 });
      vi.stubEnv("NEXT_PUBLIC_V2", "");
      expect(await outcome(page)).toEqual({ redirect: `/${ticker}/${section}`, status: 307 });
    }
  });

  it("/activity, /collect and /vault/nvda: permanent to /legacy/* in v2, the v1 page in v1", async () => {
    const pairs = [
      [await import("./activity/page"), "/legacy/activity", (await import("./legacy/activity/page")).default],
      [await import("./collect/page"), "/legacy/collect", (await import("./legacy/collect/page")).default],
      [await import("./vault/nvda/page"), "/legacy/vault/nvda", (await import("./legacy/vault/nvda/page")).default],
    ] as const;
    for (const [mod, to, legacy] of pairs) {
      vi.stubEnv("NEXT_PUBLIC_V2", "1");
      expect(await outcome(mod.default), to).toEqual({ redirect: to, status: 308 });
      vi.stubEnv("NEXT_PUBLIC_V2", "");
      expect(typeOf(await outcome(mod.default)), to).toBe(legacy);
    }
  });

  it("/vault/nvda/cycle: permanent to the legacy cycle path in v2, temporary to /book in v1", async () => {
    const { default: page } = await import("./vault/nvda/cycle/page");
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    expect(await outcome(page)).toEqual({ redirect: "/legacy/vault/nvda/cycle", status: 308 });
    vi.stubEnv("NEXT_PUBLIC_V2", "");
    expect(await outcome(page)).toEqual({ redirect: "/book", status: 307 });
  });

  for (const section of ["account", "book"] as const) {
    it(`/[ticker]/${section}: v2 redirects permanently to /legacy and is noindex; v1 renders the legacy page`, async () => {
      const mod = section === "account" ? await import("./[ticker]/account/page") : await import("./[ticker]/book/page");
      const legacy = section === "account" ? await import("./legacy/[ticker]/account/page") : await import("./legacy/[ticker]/book/page");
      const props = { params: Promise.resolve({ ticker: "nvda" }) };
      expect(mod.dynamicParams).toBe(false);
      expect(mod.generateStaticParams).toBe(legacy.generateStaticParams);
      vi.stubEnv("NEXT_PUBLIC_V2", "1");
      expect(await mod.generateMetadata(props)).toEqual({ robots: { index: false } });
      expect(await outcome(() => mod.default(props))).toEqual({ redirect: `/legacy/nvda/${section}`, status: 308 });
      vi.stubEnv("NEXT_PUBLIC_V2", "");
      expect(await mod.generateMetadata(props)).toEqual(await legacy.generateMetadata(props));
      const el = (await outcome(() => mod.default(props))).value as ReactElement<typeof props>;
      expect(el.type).toBe(legacy.default);
      expect(el.props.params).toBe(props.params);
    });
  }
});

describe("robots", () => {
  async function fresh(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return {
      home: (await import("./page")).metadata,
      leaderboard: (await import("./leaderboard/page")).metadata,
      wins: (await import("./wins/page")).metadata,
      makers: (await import("./makers/page")).metadata,
      markets: (await import("./trust/markets/page")).metadata,
      portfolio: (await import("./portfolio/page")).metadata,
      vaults: (await import("./vaults/page")).metadata,
      house: (await import("./house/page")).metadata,
      notifications: (await import("./settings/notifications/page")).metadata,
      layout: (await import("./layout")).metadata,
    };
  }
  it("v2, not a preview: public buyer pages index; private pages never; the root layout default stays noindex", async () => {
    const m = await fresh({ NEXT_PUBLIC_V2: "1", NEXT_PUBLIC_DEV_PREVIEW: "" });
    for (const k of ["home", "leaderboard", "wins", "makers", "markets"] as const) expect(m[k].robots, k).toEqual({ index: true, follow: true });
    for (const k of ["portfolio", "vaults", "house", "notifications"] as const) expect(m[k].robots, k).toEqual(PRIVATE);
    expect(m.layout.robots).toEqual({ index: false, follow: true });
    expect(m.layout.title).toBe("StonkHouse — buy an outcome");
    expect(m.leaderboard.alternates).toEqual({ canonical: "/leaderboard" });
  });

  it("a dev preview is never indexed or followed, even in v2", async () => {
    const m = await fresh({ NEXT_PUBLIC_V2: "1", NEXT_PUBLIC_DEV_PREVIEW: "1" });
    for (const k of ["home", "leaderboard", "wins", "makers", "markets"] as const) expect(m[k].robots, k).toEqual({ index: false, follow: false });
    expect(m.layout.robots).toEqual({ index: false, follow: false });
  });

  it("v1: nothing public is indexed; the layout carries the v1 title and description", async () => {
    const m = await fresh({ NEXT_PUBLIC_V2: "", NEXT_PUBLIC_DEV_PREVIEW: "" });
    expect(m.home.robots).toEqual({ index: false, follow: true });
    expect(m.layout.title).toBe("StonkHouse — let your stonks work for you");
    expect(m.layout.openGraph).toMatchObject({ title: "StonkHouse — let your stonks work for you", siteName: "StonkHouse" });
    expect(String(m.layout.metadataBase)).toMatch(/^https:\/\//);
  });
});

describe("/pnl/[id]", () => {
  const pnl = JSON.parse(readFileSync(resolve(import.meta.dirname,
    "../../ops/fixtures/api/v2/pnl/87928758254318692721909164101369622513960639781458875980445111726519827316414-0x4088c59Eb3fB713B124f182E7083AEb3358A030B.json"), "utf8")) as { ticker: string };
  const props = (id: string) => ({ params: Promise.resolve({ id }) });
  /** The robots cases reset the module registry, so read the mock from the current one. */
  async function loader() {
    const { loadPnl } = await import("@/components/v2/PnlData");
    vi.mocked(loadPnl).mockReset();
    return vi.mocked(loadPnl);
  }

  it("v1: 404 and a noindex placeholder title", async () => {
    const mod = await import("./pnl/[id]/page");
    const loadPnl = await loader();
    vi.stubEnv("NEXT_PUBLIC_V2", "");
    expect(await outcome(() => mod.default(props("abc")))).toEqual({ notFound: true });
    expect(await mod.generateMetadata(props("abc"))).toEqual({ title: "StonkHouse", robots: { index: false, follow: true } });
    expect(loadPnl).not.toHaveBeenCalled();
  });

  it("v2: an invalid id 404s without a load; a valid one mounts the receipt with what loadPnl returned", async () => {
    const mod = await import("./pnl/[id]/page");
    const { PnlReceipt } = await import("@/components/v2/PnlReceipt");
    const loadPnl = await loader();
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    loadPnl.mockResolvedValue(pnl as never);
    expect(await outcome(() => mod.default(props("../etc")))).toEqual({ notFound: true });
    expect(await outcome(() => mod.default(props("x".repeat(181))))).toEqual({ notFound: true });
    expect(loadPnl).not.toHaveBeenCalled();
    const el = (await outcome(() => mod.default(props("pnl-1")))).value as ReactElement<{ pnl: unknown }>;
    expect(isValidElement(el) && el.type).toBe(PnlReceipt);
    expect(el.props.pnl).toBe(pnl);
    expect(loadPnl).toHaveBeenCalledWith("pnl-1");
  });

  it("v2 metadata: the outcome's multiple and ticker, an encoded canonical and card; indexable only when found", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2", "1");
    vi.stubEnv("NEXT_PUBLIC_DEV_PREVIEW", "");
    const mod = await import("./pnl/[id]/page");
    const load = await loader();
    const { receiptImageCopy } = await import("@/components/v2/PnlText");
    load.mockResolvedValue(pnl as never);
    const copy = receiptImageCopy(pnl as never);
    const m = await mod.generateMetadata(props("a b"));
    expect(m.title).toBe(`${copy.multiple} ${pnl.ticker} outcome — StonkHouse`);
    expect(m.title).toBe("4.29× NVDA outcome — StonkHouse");
    expect(m.description).toBe("1.03 → 4.42 USDG value. Max loss was 1.03 USDG.");
    expect(m.alternates).toEqual({ canonical: "/pnl/a%20b" });
    expect(m.openGraph).toMatchObject({ images: [{ url: "/pnl/a%20b/opengraph-image", width: 1200, height: 630 }] });
    expect(m.robots).toEqual({ index: true, follow: true });
    load.mockResolvedValue(null);
    const missing = await mod.generateMetadata(props("gone"));
    expect(missing.title).toBe("StonkHouse outcome");
    expect(missing.description).toBe("Explore verifiable option outcomes on Robinhood Chain.");
    expect(missing.robots).toEqual({ index: false, follow: true });
  });
});

describe("/legal", () => {
  it("every TOC entry links a heading on the page, and the US-person perimeter is stated", async () => {
    const { default: Legal, metadata } = await import("./legal/page");
    const html = renderToStaticMarkup(createElement(Legal));
    const anchors = [...new Set([...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!))];
    expect(anchors).toEqual(["geographic-restrictions", "stock-token", "vault-share", "no-advice", "no-affiliation"]);
    for (const id of anchors) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("This interface is not available to US persons.");
    expect(metadata.title).toBe("Legal — Stonkhouse");
  });
});
