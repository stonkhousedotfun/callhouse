import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { VaultsOverview } from "@/components/v2/VaultsOverview";

export const metadata: Metadata = { title: "Vaults — StonkHouse", robots: { index: false, follow: true } };

export default function VaultsPage() {
  if (process.env.NEXT_PUBLIC_V2 !== "1") notFound();
  return <VaultsOverview />;
}
