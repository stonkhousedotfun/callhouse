import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HouseVault } from "@/components/v2/HouseVault";
import { MarketAccessGate } from "@/components/v2/MarketAccessGate";
import { NotListedMarket } from "@/components/v2/NotListedMarket";
import { isV2Live, v2Markets } from "@/lib/markets";
import { parseV2Ticker } from "@/app/v2-route-params";
import { parseVaultParam } from "@/lib/v2/houseVaultSelect";

type Params = { ticker: string };
type Search = Record<string, string | string[] | undefined>;
export const dynamicParams = false;
export function generateStaticParams(): Params[] { return v2Markets().map((market) => ({ ticker: market.ticker.toLowerCase() })); }
export const metadata: Metadata = { title: "House vault by market — StonkHouse", robots: { index: false, follow: true } };

/**
 * `?vault=<address>` opens one exact House vault of the market (a market holds a weekly and a daily vault once
 * the daily ones are live). A malformed value is ignored and the market's default vault is shown. `searchParams` is
 * optional and may be absent: stale-market-routes.test.ts renders this page with `params` only.
 */
export default async function HouseMarketPage({ params, searchParams }: { params: Promise<Params>; searchParams?: Promise<Search> }) {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  const market = parseV2Ticker((await params).ticker);
  if (!market) notFound();
  const vault = parseVaultParam(searchParams === undefined ? undefined : (await searchParams).vault);
  const registered = market.v2.registeredAt !== null;
  if (!isV2Live(market.ticker)) return <NotListedMarket ticker={market.ticker} />;
  return <MarketAccessGate ticker={market.ticker} registered={registered} releaseStatus={market.v2.status}>
    <HouseVault ticker={market.ticker} vault={vault} />
  </MarketAccessGate>;
}
