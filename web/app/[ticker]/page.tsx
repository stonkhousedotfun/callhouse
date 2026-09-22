import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MarketAccessGate } from "@/components/v2/MarketAccessGate";
import { MarketPage } from "@/components/v2/MarketPage";
import { NotListedMarket } from "@/components/v2/NotListedMarket";
import { isV2Live, v2Markets } from "@/lib/markets";
import { parseV2Ticker } from "@/app/v2-route-params";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";
import { NOT_LISTED_LABEL } from "@/lib/v2/marketAccess";

type Params = { ticker: string };
export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return v2Markets().map((market) => ({ ticker: market.ticker.toLowerCase() }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const market = parseV2Ticker((await params).ticker);
  if (!market) return { title: "Not found — StonkHouse", robots: { index: false } };
  if (!isV2Live(market.ticker)) return {
    title: `${market.ticker} — ${NOT_LISTED_LABEL}`,
    description: `${market.ticker} options are not listed for trading.`,
    alternates: { canonical: `/${market.ticker.toLowerCase()}` },
    robots: { index: false, follow: PUBLIC_V2_ROBOTS.follow },
  };
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
  const registered = market.v2.registeredAt !== null;
  // Registered on chain but not released live (or released but not enabled yet): the page renders LOCKED —
  // every control faded and disabled, the Safe's schedule counting down on top (LaunchCountdown.tsx).
  // Unregistered rows keep the plain "not listed" page: there is nothing to count down to.
  if (!isV2Live(market.ticker) && !registered) return <NotListedMarket ticker={market.ticker} />;
  return <MarketAccessGate ticker={market.ticker} registered={registered} releaseStatus={market.v2.status}>
    <MarketPage ticker={market.ticker} />
  </MarketAccessGate>;
}
