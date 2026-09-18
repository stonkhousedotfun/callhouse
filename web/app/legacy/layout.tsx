import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FreezeBanner } from "@/components/legacy/FreezeBanner";
import { LEGACY_MARKETS } from "@/lib/legacy";
import { v1FrozenAt } from "@/lib/markets";

export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function LegacyLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  const dates = Object.fromEntries(LEGACY_MARKETS.map((market) => [market.ticker, v1FrozenAt(market.ticker)]));
  return <><FreezeBanner dates={dates} />{children}</>;
}
