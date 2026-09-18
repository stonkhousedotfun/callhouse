import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MarketPage } from "@/components/v2/MarketPage";
import { ALL_MARKETS } from "@/lib/markets";
import { parseV2Ticker } from "@/app/v2-route-params";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

type Params = { ticker: string };
export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return ALL_MARKETS.map((market) => ({ ticker: market.ticker.toLowerCase() }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const market = parseV2Ticker((await params).ticker);
  if (!market) return { title: "Not found — StonkHouse", robots: { index: false } };
  return {
    title: `${market.ticker} options — StonkHouse`,
    description: `Explore ${market.ticker} option series and compare maximum loss with possible payouts.`,
    alternates: { canonical: `/${market.ticker.toLowerCase()}` },
    robots: PUBLIC_V2_ROBOTS,
  };
}

export default async function TickerPage({ params }: { params: Promise<Params> }) {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  const market = parseV2Ticker((await params).ticker);
  if (!market) notFound();
  return <MarketPage ticker={market.ticker} />;
}
