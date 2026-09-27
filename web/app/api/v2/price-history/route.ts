import { NextResponse } from "next/server";

import { PRICE_HISTORY_CACHE, servePriceHistory } from "@/lib/v2/priceHistory";

/**
 * GET /api/v2/price-history?ticker=NVDA&range=1D — candles for the market page's Price view.
 *
 * The browser calls this, never the third party: the source (GeckoTerminal) is read here, once per pool and range
 * per three minutes for every visitor together, under a deadline, with a failure remembered for thirty seconds. The
 * pool comes from the registry; the query can only name a registered ticker and one of four ranges, so it cannot
 * point the server at another host or path. lib/v2/priceHistory.ts has the whole contract.
 *
 * CACHING. A good answer may be reused by the browser for a minute and by a shared cache for three (the server's own
 * cache window); a failure is never cached downstream, so the page retries on its next poll.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const { status, body } = await servePriceHistory(
    { ticker: searchParams.get("ticker"), range: searchParams.get("range") },
    { fetch: globalThis.fetch, now: () => Math.floor(Date.now() / 1000), cache: PRICE_HISTORY_CACHE },
  );
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": body.ok ? "public, max-age=60, s-maxage=180, stale-while-revalidate=120" : "no-store" },
  });
}
