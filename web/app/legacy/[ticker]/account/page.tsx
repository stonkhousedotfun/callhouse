import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AccountView } from "@/components/AccountView";
import { LEGACY_MARKETS, legacyMarket } from "@/lib/legacy";

/** Deployed v1 factories keep their account routes after registry status changes. */
type Params = { ticker: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return LEGACY_MARKETS.map((m) => ({ ticker: m.ticker.toLowerCase() }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const market = legacyMarket((await params).ticker);
  if (market === undefined) return { title: "Not found — StonkHouse" };
  return {
    title: `${market.ticker} account — StonkHouse`,
    description: `Settle and withdraw from your legacy ${market.ticker} writer account.`,
  };
}

export default async function MarketAccountPage({ params }: { params: Promise<Params> }) {
  const market = legacyMarket((await params).ticker);
  if (market === undefined) notFound();
  return <AccountView market={market} />;
}
