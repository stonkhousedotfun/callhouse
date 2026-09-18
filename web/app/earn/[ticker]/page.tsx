import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EarnMarket } from "@/components/v2/EarnMarket";
import { ALL_MARKETS } from "@/lib/markets";
import { parseV2Ticker } from "@/app/v2-route-params";

type Params = { ticker: string };
export const dynamicParams = false;
export function generateStaticParams(): Params[] { return ALL_MARKETS.map((market) => ({ ticker: market.ticker.toLowerCase() })); }
export const metadata: Metadata = { title: "Earn by market — StonkHouse", robots: { index: false, follow: true } };

export default async function EarnMarketPage({ params }: { params: Promise<Params> }) {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  const market = parseV2Ticker((await params).ticker);
  if (!market) notFound();
  return <EarnMarket ticker={market.ticker} />;
}
