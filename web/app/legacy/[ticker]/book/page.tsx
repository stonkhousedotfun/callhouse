import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookView } from "@/components/BookView";
import { LEGACY_MARKETS, legacyMarket } from "@/lib/legacy";

/** Deployed v1 factories keep buyer exercise routes through the last option window. */
type Params = { ticker: string };

export const dynamicParams = false;

export function generateStaticParams(): Params[] {
  return LEGACY_MARKETS.map((m) => ({ ticker: m.ticker.toLowerCase() }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const market = legacyMarket((await params).ticker);
  if (market === undefined) return { title: "Not found — StonkHouse" };
  return {
    title: `${market.ticker} book — StonkHouse`,
    description: `Exercise an existing legacy ${market.ticker} call during its option window.`,
  };
}

export default async function MarketBookPage({ params }: { params: Promise<Params> }) {
  const market = legacyMarket((await params).ticker);
  if (market === undefined) notFound();
  return <BookView market={market} />;
}
