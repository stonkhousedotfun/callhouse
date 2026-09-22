import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LenderRewardsPage } from "@/components/v2/LenderRewardsPage";

export const metadata: Metadata = { title: "Lender rewards — StonkHouse", robots: { index: false, follow: true } };

export default function LendRewardsPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <LenderRewardsPage />;
}
