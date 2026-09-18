import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { SeriesPage as SeriesView } from "@/components/v2/SeriesPage";
import { parseV2Series, parseV2Ticker } from "@/app/v2-route-params";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

type Params = { ticker: string; series: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { ticker, series } = await params;
  const market = parseV2Ticker(ticker);
  const id = market ? parseV2Series(market, series) : undefined;
  if (!market || !id) return { title: "Not found — StonkHouse", robots: { index: false } };
  return {
    title: `${market.ticker} option ${id} — StonkHouse`,
    alternates: { canonical: `/${ticker}/${id}` },
    robots: PUBLIC_V2_ROBOTS,
  };
}

export default async function SeriesPage({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  const [{ ticker, series }, query] = await Promise.all([params, searchParams]);
  const market = parseV2Ticker(ticker);
  if (!market) notFound();
  const id = parseV2Series(market, series);
  if (!id) notFound();
  const rawShares = typeof query.shares === "string" ? query.shares : undefined;
  const initialShares = rawShares && /^(?:[1-9]\d{0,3}|0)(?:\.\d{1,2})?$/.test(rawShares) && Number(rawShares) > 0 ? rawShares : undefined;
  const suffix = query.buy === "1" ? `?buy=1${initialShares ? `&shares=${encodeURIComponent(initialShares)}` : ""}` : "";
  if (series !== id) permanentRedirect(`/${ticker}/${id}${suffix}`);
  return <SeriesView ticker={market.ticker} longId={id} initialShares={initialShares} openTicket={query.buy === "1"} />;
}
