/**
 * The
 * series route shows no put page for a market whose registry flag is not `puts: true`:
 * - a readable put alias (`/nvda/p-200-2026-09-25`) names its side, so the page sends it to the calls view, /nvda (307);
 * - a numeric put id is a hash of (asset, isPut, strike, expiry) and does not, so the page hands it to MarketPage, whose
 *   shownRouteId hides that put series once it resolves (MarketPage.test.ts).
 * With `puts: true` the same alias still resolves to its put series. The flag is read from the registry; the puts:true
 * case forces it on one market through a mocked getV2Market, because no launch market enables puts today.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MarketPage, shownRouteId } from "@/components/v2/MarketPage";
import { getV2Market, v2Markets } from "@/lib/markets";
import { longIdOf } from "@/lib/v2/seriesId";
import * as page from "./page";

const force = vi.hoisted(() => ({ puts: false }));

vi.mock("@/lib/markets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/markets")>();
  return {
    ...actual,
    getV2Market: (ticker: string) => {
      const market = actual.getV2Market(ticker);
      return market && force.puts ? { ...market, v2: { ...market.v2, puts: true } } : market;
    },
  };
});

const market = v2Markets()[0]!;
const ticker = market.ticker.toLowerCase();
// 2026-09-25 is a Friday in EDT: 16:00 New York is 20:00 UTC. parseV2Series resolves the alias to this id.
const putId = longIdOf(market.asset, true, 200_000_000n, Date.UTC(2026, 8, 25, 20) / 1000).toString();
const callId = longIdOf(market.asset, false, 200_000_000n, Date.UTC(2026, 8, 25, 20) / 1000).toString();

/** The MarketPage element inside what the page returned, or undefined. The page is not rendered, only walked. */
function marketPageIn(node: ReactNode): ReactElement<{ ticker: string; longId?: string }> | undefined {
  if (!isValidElement(node)) return undefined;
  if (node.type === MarketPage) return node as ReactElement<{ ticker: string; longId?: string }>;
  const children = (node.props as { children?: ReactNode }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = marketPageIn(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Render the route; a Next redirect comes back as { to, status } (its digest is NEXT_REDIRECT;type;url;status;). */
async function visit(series: string, query: Record<string, string> = {}) {
  try {
    const element = await page.default({ params: Promise.resolve({ ticker, series }), searchParams: Promise.resolve(query) });
    return { element };
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (!digest.startsWith("NEXT_REDIRECT;")) throw error;
    const parts = digest.split(";");
    return { to: parts[2], status: Number(parts[3]) };
  }
}

describe("/[ticker]/[series] shows no put page on a market without puts", () => {
  const before = process.env.NEXT_PUBLIC_V2;
  beforeAll(() => { process.env.NEXT_PUBLIC_V2 = "1"; });
  afterAll(() => { process.env.NEXT_PUBLIC_V2 = before; force.puts = false; });

  it("the launch market under test has puts disabled in the registry", () => {
    force.puts = false;
    expect(getV2Market(ticker)?.v2.puts).toBe(false);
  });

  it("puts:false: a put alias goes to the calls view with a temporary redirect, ticket query dropped", async () => {
    force.puts = false;
    expect(await visit("p-200-2026-09-25")).toEqual({ to: `/${ticker}`, status: 307 });
    expect(await visit("p-200-2026-09-25", { buy: "1", shares: "2" })).toEqual({ to: `/${ticker}`, status: 307 });
  });

  it("puts:false: a call alias still resolves to its series (permanent, as before)", async () => {
    force.puts = false;
    expect(await visit("c-200-2026-09-25")).toEqual({ to: `/${ticker}/${callId}`, status: 308 });
  });

  it("puts:false: a numeric put id reaches MarketPage, which hides that put series", async () => {
    force.puts = false;
    const { element } = await visit(putId);
    const shown = marketPageIn(element);
    expect(shown, "the page renders MarketPage for a launch market").toBeDefined();
    expect(shown!.props.longId).toBe(putId);
    expect(shownRouteId(putId, { isPut: true }, false)).toBeNull();
  });

  it("puts:true: the put alias resolves to its put series", async () => {
    force.puts = true;
    expect(getV2Market(ticker)?.v2.puts).toBe(true);
    expect(await visit("p-200-2026-09-25")).toEqual({ to: `/${ticker}/${putId}`, status: 308 });
    expect(shownRouteId(putId, { isPut: true }, true)).toBe(putId);
    force.puts = false;
  });
});
