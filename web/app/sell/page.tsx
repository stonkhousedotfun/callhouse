import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EarnOverview } from "@/components/v2/EarnOverview";

/**
 * Sell options: the self-directed writer feature. It lived at /earn until
 * "Earn" went to the USDG lending vault; old /earn/<ticker> links redirect here (app/earn/[ticker]/page.tsx). The component
 * keeps its internal name (EarnOverview); only the route and the words a reader sees changed.
 */
export const metadata: Metadata = { title: "Sell options — StonkHouse", robots: { index: false, follow: true } };

export default function SellPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <EarnOverview />;
}
