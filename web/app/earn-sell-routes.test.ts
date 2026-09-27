/**
 * /earn is the USDG lending vault (the component that was /lend),
 * the self-directed writer pages moved to /sell, and every old address lands on the new one instead of a 404:
 * /lend → /earn, /lend/rewards → /earn/rewards, /earn/<ticker> → /sell/<ticker> with its query string. On v1, where
 * none of these pages ever existed, they stay 404s.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ redirectedTo: null as string | null }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  permanentRedirect: (to: string) => {
    nav.redirectedTo = to;
    throw new Error(`permanentRedirect(${to})`);
  },
  notFound: () => {
    throw new Error("notFound()");
  },
}));

import EarnPage, { metadata as earnMetadata } from "@/app/earn/page";
import EarnRewardsPage from "@/app/earn/rewards/page";
import EarnTickerRedirect from "@/app/earn/[ticker]/page";
import LendRedirect from "@/app/lend/page";
import LendRewardsRedirect from "@/app/lend/rewards/page";
import robots from "@/app/robots";
import SellPage, { metadata as sellMetadata } from "@/app/sell/page";
import sitemap from "@/app/sitemap";
import { sellHref } from "@/app/v2-route-params";
import { EarnOverview } from "@/components/v2/EarnOverview";
import { LendVault } from "@/components/v2/LendVault";
import { LenderRewardsPage } from "@/components/v2/LenderRewardsPage";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";
import { APP_URL } from "@/lib/site";

afterEach(() => {
  vi.unstubAllEnvs();
  nav.redirectedTo = null;
});

const v2 = (on = true) => vi.stubEnv("NEXT_PUBLIC_V2", on ? "1" : "");
const earnTicker = (ticker: string, search?: Record<string, string | string[] | undefined>) =>
  EarnTickerRedirect({ params: Promise.resolve({ ticker }), ...(search ? { searchParams: Promise.resolve(search) } : {}) });

describe("/earn is the Earn vault (the USDG lending vault)", () => {
  it("renders the lending vault page, is indexed like the public pages, and is canonical at /earn", () => {
    v2();
    expect(EarnPage().type).toBe(LendVault);
    expect(earnMetadata.robots).toBe(PUBLIC_V2_ROBOTS);
    expect(earnMetadata.alternates?.canonical).toBe("/earn");
    expect(String(earnMetadata.title)).toMatch(/^Earn\b/);
  });

  it("/earn/rewards renders the lender rewards page", () => {
    v2();
    expect(EarnRewardsPage().type).toBe(LenderRewardsPage);
  });

  it("the sitemap lists /earn, and neither the redirects nor the writer pages", () => {
    v2();
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${APP_URL}/earn`);
    for (const path of ["/lend", "/sell"]) expect(urls).not.toContain(`${APP_URL}${path}`);
  });

  it("robots keeps the writer pages (/sell) out and lets /earn in", () => {
    v2();
    const rule = [robots().rules].flat()[0]!;
    const disallow = [rule.disallow ?? []].flat();
    expect(disallow).toContain("/sell");
    expect(disallow).not.toContain("/earn");
  });

  it("v1 has no Earn page", () => {
    v2(false);
    expect(() => EarnPage()).toThrow("notFound()");
    expect(() => EarnRewardsPage()).toThrow("notFound()");
  });
});

describe("/sell is Sell options (the writer pages that were /earn)", () => {
  it("renders the writer overview and stays out of the index", () => {
    v2();
    expect(SellPage().type).toBe(EarnOverview);
    expect(String(sellMetadata.title)).toMatch(/^Sell options\b/);
    expect(sellMetadata.robots).toEqual({ index: false, follow: true });
  });
});

describe("old addresses redirect permanently", () => {
  it("/lend → /earn and /lend/rewards → /earn/rewards", () => {
    v2();
    expect(() => LendRedirect()).toThrow("permanentRedirect(/earn)");
    expect(nav.redirectedTo).toBe("/earn");
    expect(() => LendRewardsRedirect()).toThrow("permanentRedirect(/earn/rewards)");
    expect(nav.redirectedTo).toBe("/earn/rewards");
  });

  it("/earn/<ticker> → /sell/<ticker>, keeping the query string", async () => {
    v2();
    await expect(earnTicker("nvda")).rejects.toThrow("permanentRedirect(/sell/nvda)");
    expect(nav.redirectedTo).toBe("/sell/nvda");
    await expect(earnTicker("spcx", { edit: "smart-pricing" })).rejects.toThrow("permanentRedirect(/sell/spcx?edit=smart-pricing)");
    expect(sellHref("NVDA", { a: ["1", "2"], b: undefined, c: "x y" })).toBe("/sell/nvda?a=1&a=2&c=x+y");
  });

  it("a ticker outside the launch set is still a 404, not a redirect to one", async () => {
    v2();
    // AAPL is in the registry's `skipped` record (not in launchSet.markets), like every removed market.
    await expect(earnTicker("aapl")).rejects.toThrow("notFound()");
    expect(nav.redirectedTo).toBeNull();
  });

  it("on v1 the old addresses are 404s, as they always were", async () => {
    v2(false);
    expect(() => LendRedirect()).toThrow("notFound()");
    expect(() => LendRewardsRedirect()).toThrow("notFound()");
    await expect(earnTicker("nvda")).rejects.toThrow("notFound()");
    expect(nav.redirectedTo).toBeNull();
  });
});
