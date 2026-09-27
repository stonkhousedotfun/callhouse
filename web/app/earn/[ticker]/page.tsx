import { notFound, permanentRedirect } from "next/navigation";

import { v2Markets } from "@/lib/markets";
import { parseV2Ticker, sellHref } from "@/app/v2-route-params";

/**
 * /earn/<ticker> was the per-market writer page until "Earn" went to the lending vault.
 * That page is /sell/<ticker> now; old links and bookmarks land there with their query string (Portfolio
 * used to link /earn/<ticker>?edit=smart-pricing#auto-roll; the browser keeps the #fragment across a redirect itself).
 * A ticker outside the launch set still 404s, as it did before the move (app/stale-market-routes.test.ts).
 */
type Params = { ticker: string };
export const dynamicParams = false;
export function generateStaticParams(): Params[] { return v2Markets().map((market) => ({ ticker: market.ticker.toLowerCase() })); }

export default async function EarnTickerRedirect({ params, searchParams }: {
  params: Promise<Params>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  const market = parseV2Ticker((await params).ticker);
  if (!market) notFound();
  permanentRedirect(sellHref(market.ticker, (await searchParams) ?? {}));
}
