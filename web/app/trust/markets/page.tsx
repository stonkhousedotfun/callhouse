import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { MarketDirectory } from "@/components/v2/MarketDirectory";
import { PUBLIC_V2_ROBOTS } from "@/lib/devPreview";

/**
 * Market status: every registry market's availability, accepted oracle spot and settlement
 * behaviour. It used to be the top-level /markets, a second nav entry beside Buy that read as
 * another place to shop; it is a status reference, so it sits under Trust
 * and the Trust nav entry is lit here. /markets permanently redirects to this route.
 */
export const metadata: Metadata = {
  title: "Market status — StonkHouse",
  description: "Which Stock Token option markets are live, coming soon, paused or deferred, with each price and settlement setup.",
  alternates: { canonical: "/trust/markets" },
  robots: PUBLIC_V2_ROBOTS,
};

export default function MarketStatusPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <MarketDirectory />;
}
