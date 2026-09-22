import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { EarnMarket } from "@/components/v2/EarnMarket";
import { MarketAccessGate } from "@/components/v2/MarketAccessGate";
import { NotListedMarket } from "@/components/v2/NotListedMarket";
import { isV2Live, v2Markets } from "@/lib/markets";
import { parseV2Ticker } from "@/app/v2-route-params";

type Params = { ticker: string };
export const dynamicParams = false;
export function generateStaticParams(): Params[] { return v2Markets().map((market) => ({ ticker: market.ticker.toLowerCase() })); }
export const metadata: Metadata = { title: "Earn by market — StonkHouse", robots: { index: false, follow: true } };

export default async function EarnMarketPage({ params }: { params: Promise<Params> }) {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  const market = parseV2Ticker((await params).ticker);
  if (!market) notFound();
  const registered = market.v2.registeredAt !== null;
  if (!isV2Live(market.ticker)) return <NotListedMarket ticker={market.ticker} />;
  return <MarketAccessGate ticker={market.ticker} registered={registered} releaseStatus={market.v2.status}>
    <EarnMarket ticker={market.ticker} />
  </MarketAccessGate>;
}
