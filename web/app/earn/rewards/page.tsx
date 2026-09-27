import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LenderRewardsPage } from "@/components/v2/LenderRewardsPage";

/** Earn vault lender rewards (moved from /lend/rewards, which now redirects here). */
export const metadata: Metadata = { title: "Earn rewards — StonkHouse", robots: { index: false, follow: true } };

export default function EarnRewardsPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <LenderRewardsPage />;
}
